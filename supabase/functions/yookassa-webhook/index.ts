import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.3';
import { clientAddress, json, sha256Hex, readJsonBody } from '../_shared/http.ts';
import { applyFailedYookassaPayment, applySucceededYookassaPayment, redactPayment, yookassaRequest } from '../_shared/yookassa.ts';

Deno.serve(async req => {
  const headers = { 'Cache-Control': 'no-store' };
  if (req.method !== 'POST') return json({ ok: false }, 405, headers);
  if (Number(req.headers.get('content-length') || 0) > 100_000) return json({ ok: false }, 413, headers);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const encryptionSecret = Deno.env.get('BILLING_ENCRYPTION_KEY') || '';
  if (!supabaseUrl || !serviceRoleKey || encryptionSecret.length < 24) return json({ ok: false }, 503, headers);
  const parsed = await readJsonBody(req, 100_000);
  if (!parsed.ok) return json({ ok: false }, parsed.error === 'payload_too_large' ? 413 : 400, headers);
  const body = parsed.value;
  const eventType = String(body?.event || '');
  const incomingId = String(body?.object?.id || '');
  if (!['payment.succeeded', 'payment.canceled', 'refund.succeeded'].includes(eventType) || !/^[0-9a-f-]{20,80}$/i.test(incomingId)) {
    return json({ ok: false }, 400, headers);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const requestKey = await sha256Hex(`${serviceRoleKey}:yookassa-webhook:${clientAddress(req)}`);
  const { data: withinQuota, error: quotaError } = await supabase.rpc('consume_analytics_quota', {
    p_key_hash: `webhook:${requestKey}`,
    p_limit: 60
  });
  if (quotaError) return json({ ok: false }, 503, headers);
  if (!withinQuota) return json({ ok: false }, 429, headers);
  let verifiedPayload: any = null;
  try {
    if (eventType === 'refund.succeeded') {
      const refund = await yookassaRequest(`/refunds/${encodeURIComponent(incomingId)}`);
      if (refund?.status !== 'succeeded') throw new Error('webhook_status_mismatch');
      const paymentId = String(refund?.payment_id || '');
      if (!paymentId) throw new Error('refund_payment_missing');
      const payment = await yookassaRequest(`/payments/${encodeURIComponent(paymentId)}`);
      verifiedPayload = { refund, payment };
      await processRefund(supabase, refund, payment);
      return json({ ok: true }, 200, headers);
    }

    const payment = await yookassaRequest(`/payments/${encodeURIComponent(incomingId)}`);
    verifiedPayload = payment;
    const actualEvent = payment.status === 'succeeded' ? 'payment.succeeded' : payment.status === 'canceled' ? 'payment.canceled' : '';
    if (actualEvent !== eventType) throw new Error('webhook_status_mismatch');
    const eventKey = `${eventType}:${incomingId}`;
    const billingIdentityId = Number(payment?.metadata?.telegram_id || 0);
    const { data: previous, error: previousError } = await supabase.from('billing_events').select('id,status').eq('provider', 'yookassa').eq('event_key', eventKey).maybeSingle();
    if (previousError) throw previousError;
    if (previous?.status === 'processed') return json({ ok: true }, 200, headers);
    const eventValues = {
      provider: 'yookassa', event_key: eventKey, event_type: eventType, status: 'processing',
      external_payment_id: incomingId, telegram_id: billingIdentityId > 0 ? billingIdentityId : null,
      payload: redactPayment(payment), error: null
    };
    const savedEvent = await supabase.from('billing_events').upsert(eventValues, { onConflict: 'provider,event_key' });
    if (savedEvent.error) throw savedEvent.error;

    if (eventType === 'payment.succeeded') await applySucceededYookassaPayment({ supabase, payment, encryptionSecret });
    else await applyFailedYookassaPayment({ supabase, payment });
    const completedEvent = await supabase.from('billing_events').update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('provider', 'yookassa').eq('event_key', eventKey);
    if (completedEvent.error) throw completedEvent.error;
    return json({ ok: true }, 200, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown';
    if (verifiedPayload) {
      await supabase.from('billing_events').upsert({
        provider: 'yookassa', event_key: `${eventType}:${incomingId}`, event_type: eventType,
        status: 'failed', external_payment_id: incomingId,
        payload: verifiedPayload.payment
          ? { refund: verifiedPayload.refund?.id || null, payment: redactPayment(verifiedPayload.payment) }
          : redactPayment(verifiedPayload),
        error: message
      }, { onConflict: 'provider,event_key', ignoreDuplicates: true });
    }
    console.error('YooKassa webhook failed', message);
    return json({ ok: false }, 500, headers);
  }
});

async function processRefund(supabase: any, refund: any, payment: any) {
  const eventKey = `refund.succeeded:${refund.id}`;
  const { data: previous, error: previousError } = await supabase.from('billing_events').select('status')
    .eq('provider', 'yookassa').eq('event_key', eventKey).maybeSingle();
  if (previousError) throw previousError;
  if (previous?.status === 'processed') return;
  const telegramId = Number(payment?.metadata?.telegram_id || 0);
  const refundMinor = Math.round(Number(refund?.amount?.value || 0) * 100);
  const totalRefundMinor = Math.round(Number(payment?.refunded_amount?.value || refund?.amount?.value || 0) * 100);
  const paymentMinor = Math.round(Number(payment?.amount?.value || 0) * 100);
  if (refundMinor <= 0 || paymentMinor <= 0 || String(refund?.amount?.currency) !== String(payment?.amount?.currency)) {
    throw new Error('refund_amount_invalid');
  }
  const isFullRefund = totalRefundMinor >= paymentMinor;
  const { data: localPayment, error: localPaymentError } = await supabase.from('payments')
    .select('id,telegram_id,currency,total_amount,access_period_start,access_period_end')
    .eq('provider', 'yookassa').eq('external_payment_id', String(payment.id || '')).maybeSingle();
  if (localPaymentError) throw localPaymentError;
  if (!localPayment || Number(localPayment.telegram_id) !== telegramId) throw new Error('local_refund_payment_invalid');
  if (localPayment.currency !== String(payment?.amount?.currency) || Number(localPayment.total_amount) !== paymentMinor) {
    throw new Error('local_refund_amount_mismatch');
  }
  const { error } = await supabase.rpc('finalize_yookassa_refund', {
    p_id: localPayment.id, p_full: isFullRefund,
    p_refund: { id: refund.id, payment_id: refund.payment_id, status: refund.status, amount: refund.amount }
  });
  if (error) throw error;
}

function parseBody(rawBody: string) {
  try { return rawBody ? JSON.parse(rawBody) : null; }
  catch (_) { return null; }
}

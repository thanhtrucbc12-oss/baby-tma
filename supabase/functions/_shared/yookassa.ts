import { getBillingPlan, rubles, sealBillingSecret } from './billing.mjs';

export function getYookassaCredentials() {
  const shopId = Deno.env.get('YOOKASSA_SHOP_ID')?.trim() || undefined;
  const secretKey = Deno.env.get('YOOKASSA_SECRET_KEY')?.trim() || undefined;
  return { shopId, secretKey };
}

export async function yookassaRequest(path: string, options: {
  method?: string;
  body?: any;
  idempotenceKey?: string;
} = {}) {
  const { shopId, secretKey } = getYookassaCredentials();
  if (!shopId || !secretKey) throw new Error('yookassa_not_configured');
  const headers: Record<string, string> = {
    Authorization: `Basic ${btoa(`${shopId}:${secretKey}`)}`,
    Accept: 'application/json'
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotenceKey) headers['Idempotence-Key'] = options.idempotenceKey.slice(0, 64);
  const response = await fetch(`https://api.yookassa.ru/v3${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`yookassa_${response.status}`);
    (error as any).details = data;
    throw error;
  }
  return data;
}

export function yookassaPaymentBody({ plan, paymentId, telegramId, returnUrl, paymentMethodId, customerType, receiptEmail, savePaymentMethod = true }: {
  plan: any;
  paymentId: string;
  telegramId: number;
  returnUrl?: string;
  paymentMethodId?: string;
  customerType?: string;
  receiptEmail?: string;
  savePaymentMethod?: boolean;
}) {
  const resolvedCustomerType = customerType === 'guest' || telegramId < 0 ? 'guest' : 'telegram';
  const body: any = {
    amount: { value: rubles(plan.amountMinor), currency: 'RUB' },
    capture: true,
    description: `${plan.label} в приложении Режим Малыша`,
    metadata: {
      internal_payment_id: paymentId,
      telegram_id: String(telegramId),
      customer_type: resolvedCustomerType,
      plan: plan.key
    },
    ...(receiptEmail ? {
      receipt: {
        customer: { email: receiptEmail },
        items: [{
          description: `${plan.label} в приложении Режим Малыша`,
          quantity: 1,
          amount: { value: rubles(plan.amountMinor), currency: 'RUB' },
          vat_code: 1,
          payment_mode: 'full_payment',
          payment_subject: 'service'
        }]
      }
    } : {})
  };
  if (paymentMethodId) body.payment_method_id = paymentMethodId;
  else {
    body.confirmation = { type: 'redirect', return_url: returnUrl };
    if (savePaymentMethod) {
      body.save_payment_method = true;
      body.merchant_customer_id = resolvedCustomerType === 'guest'
        ? `web_${Math.abs(telegramId)}`
        : `tg_${telegramId}`;
    }
  }
  return body;
}

export async function applySucceededYookassaPayment({ supabase, payment, encryptionSecret }: {
  supabase: any;
  payment: any;
  encryptionSecret: string;
}) {
  if (payment?.status !== 'succeeded' || payment?.paid !== true) throw new Error('payment_not_succeeded');
  const internalPaymentId = String(payment?.metadata?.internal_payment_id || '');
  const telegramId = Number(payment?.metadata?.telegram_id || 0);
  const plan = getBillingPlan(payment?.metadata?.plan);
  if (!/^[0-9a-f-]{36}$/i.test(internalPaymentId) || !telegramId || !plan) throw new Error('payment_metadata_invalid');
  const { data: localPayment, error: localPaymentError } = await supabase.from('payments')
    .select('id,user_id,telegram_id,plan,currency,total_amount,status,external_payment_id,access_period_start,access_period_end')
    .eq('id', internalPaymentId).eq('provider', 'yookassa').maybeSingle();
  if (localPaymentError) throw localPaymentError;
  if (!localPayment) throw new Error('local_payment_not_found');
  if (Number(localPayment.telegram_id) !== telegramId || localPayment.plan !== plan.key) throw new Error('payment_owner_mismatch');
  if (localPayment.currency !== 'RUB' || Number(localPayment.total_amount) !== plan.amountMinor) throw new Error('payment_amount_mismatch');
  if (localPayment.external_payment_id && localPayment.external_payment_id !== String(payment.id)) throw new Error('payment_id_mismatch');
  if (String(payment?.amount?.currency) !== 'RUB' || Math.round(Number(payment?.amount?.value) * 100) !== plan.amountMinor) {
    throw new Error('provider_amount_mismatch');
  }
  const paymentMethod = payment?.payment_method;
  const recurringEnabled = Boolean(paymentMethod?.saved === true && paymentMethod?.id);
  const ciphertext = await sealBillingSecret(recurringEnabled ? String(paymentMethod.id) : 'one_time', encryptionSecret);
  const verified = redactPayment(payment);
  if (verified.payment_method) verified.payment_method.saved = recurringEnabled;
  const { data: result, error } = await supabase.rpc('finalize_yookassa_payment', {
    p_id: internalPaymentId, p_payment: verified, p_ciphertext: ciphertext
  });
  if (error) throw error;
  if (!result || result.ignored) return { alreadyProcessed: true };
  if (result.newly_paid) {
    await supabase.from('events').insert({
      event_name: 'payment_success',
      user_id: localPayment.user_id,
      telegram_id: telegramId > 0 ? telegramId : null,
      payload: { provider: 'yookassa', plan: plan.key, amount_minor: plan.amountMinor, recurring: recurringEnabled }
    });
  }
  return { alreadyProcessed: !result.newly_paid, currentPeriodEnd: result.current_period_end, recurring: recurringEnabled };
}

export async function applyFailedYookassaPayment({ supabase, payment }: { supabase: any; payment: any }) {
  const internalPaymentId = String(payment?.metadata?.internal_payment_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(internalPaymentId)) return;
  const now = new Date();
  await supabase.from('payments').update({
    status: 'failed', external_payment_id: String(payment.id || '') || null,
    raw_payload: redactPayment(payment), error_code: String(payment?.cancellation_details?.reason || 'payment_cancelled').slice(0, 120),
    updated_at: now.toISOString()
  }).eq('id', internalPaymentId).neq('status', 'paid');
  const agreementId = String(payment?.metadata?.agreement_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) return;
  const { data: agreement } = await supabase.from('billing_agreements').select('retry_count,telegram_id')
    .eq('id', agreementId).maybeSingle();
  if (!agreement) return;
  const retryCount = Number(agreement.retry_count || 0) + 1;
  const retryExhausted = retryCount >= 3;
  const retryDays = retryCount === 1 ? 1 : retryCount === 2 ? 3 : 7;
  await supabase.from('billing_agreements').update({
    status: retryExhausted ? 'cancelled' : 'past_due',
    cancel_at_period_end: retryExhausted,
    retry_count: retryCount,
    next_charge_at: retryExhausted ? now.toISOString() : new Date(now.getTime() + retryDays * 86400_000).toISOString(),
    last_error: String(payment?.cancellation_details?.reason || 'payment_cancelled').slice(0, 120),
    updated_at: now.toISOString()
  }).eq('id', agreementId);
  await supabase.from('subscriptions').update({
    cancel_at_period_end: retryExhausted,
    next_billing_at: retryExhausted ? null : new Date(now.getTime() + retryDays * 86400_000).toISOString(),
    last_error: retryExhausted ? 'renewal_cancelled_after_retries' : 'renewal_failed',
    updated_at: now.toISOString()
  }).eq('telegram_id', agreement.telegram_id);
}

export function redactPayment(payment: any) {
  const copy = JSON.parse(JSON.stringify(payment || {}));
  if (copy.payment_method) delete copy.payment_method.id;
  if (copy.payment_method?.card) {
    copy.payment_method.card = {
      first6: copy.payment_method.card.first6 || null,
      last4: copy.payment_method.card.last4 || null,
      card_type: copy.payment_method.card.card_type || null,
      issuer_country: copy.payment_method.card.issuer_country || null
    };
  }
  delete copy.receipt;
  delete copy.authorization_details;
  return copy;
}

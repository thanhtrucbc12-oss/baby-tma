// Read-only/unauthenticated probes: no purchases, refunds or real user records.
const assert = require('node:assert/strict');
(async () => {
  const base = 'https://jfyprwisnrubhhowipdm.functions.supabase.co/';
  for (const endpoint of ['admin-actions', 'partner-portal', 'subscription-status', 'billing-subscription', 'ai-assistant', 'telegram-notifications', 'telegram-webhook', 'create-yookassa-payment', 'sync-data']) {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 401, endpoint + ' must reject missing authentication');
    console.log(endpoint + ': 401');
  }
  const forged = await fetch(base + 'sync-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=forged' }), signal: AbortSignal.timeout(15000)
  });
  assert.equal(forged.status, 401);
  const crossOrigin = await fetch(base + 'sync-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}', signal: AbortSignal.timeout(15000)
  });
  assert.equal(crossOrigin.status, 403);
  const app = await fetch('https://arseneleshaevwork-dotcom.github.io/baby-tma/', { signal: AbortSignal.timeout(15000) });
  assert.equal(app.status, 200);
  console.log('App: 200; forged Telegram: 401; foreign origin: 403');
  console.log('HTTP security headers:', JSON.stringify({ hsts: Boolean(app.headers.get('strict-transport-security')), csp: Boolean(app.headers.get('content-security-policy')), nosniff: app.headers.get('x-content-type-options') }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

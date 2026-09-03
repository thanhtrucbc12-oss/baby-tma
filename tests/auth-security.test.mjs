import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { authenticateAppRequest, verifyTelegramInitData } from '../supabase/functions/_shared/auth.ts';

const botToken = 'synthetic-test-bot-token';
function signedInitData(authDate, user = { id: 123 }) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
const now = Math.floor(Date.now() / 1000);
assert.equal((await verifyTelegramInitData(signedInitData(now), botToken)).ok, true);
assert.equal((await verifyTelegramInitData(signedInitData(now - 86401), botToken)).ok, false);
assert.equal((await verifyTelegramInitData(signedInitData(now + 86401), botToken)).ok, false);
assert.equal((await verifyTelegramInitData(signedInitData(now).replace('123', '456'), botToken)).ok, false);
assert.equal((await verifyTelegramInitData('user=%7B%22id%22%3A123%7D', botToken)).ok, false);

const token = 'x'.repeat(48);
const calls = [];
let session = { id: 's1', user_id: 'u1', telegram_id: 123, expires_at: '2099-01-01', revoked_at: null };
let user = { id: 'u1', telegram_id: 123 };
const supabase = {
  from(table) {
    const query = {
      select() { return this; },
      eq(key, value) { calls.push({ table, key, value }); return this; },
      update() { return this; },
      async maybeSingle() { return { data: table === 'web_sessions' ? session : user }; }
    };
    return query;
  }
};
const request = headers => ({ req: new Request('https://example.test', { headers }), body: {}, supabase, botToken });
assert.equal((await authenticateAppRequest(request({}))).ok, false);
assert.equal((await authenticateAppRequest(request({ authorization: 'Bearer short' }))).ok, false);
assert.equal((await authenticateAppRequest(request({ authorization: `Bearer ${token}` }))).ok, true);
assert.ok(calls.some(call => call.key === 'token_hash' && call.value === createHash('sha256').update(token).digest('hex')));
assert.ok(!calls.some(call => call.value === token), 'raw session tokens never query storage');
user = { id: 'u1', telegram_id: 999 };
assert.equal((await authenticateAppRequest(request({ authorization: `Bearer ${token}` }))).ok, false);
user = { id: 'u1', telegram_id: 123 };
session = { ...session, revoked_at: '2026-01-01' };
assert.equal((await authenticateAppRequest(request({ authorization: `Bearer ${token}` }))).ok, false);
session = { ...session, revoked_at: null, expires_at: '2000-01-01' };
assert.equal((await authenticateAppRequest(request({ authorization: `Bearer ${token}` }))).ok, false);
console.log('ok - Telegram signature/expiry/tampering, session hashing/revocation and identity binding');

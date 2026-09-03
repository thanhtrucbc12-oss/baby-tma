const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const store = new Map();
const localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key)
};
const context = { window: {}, localStorage };
vm.runInNewContext(fs.readFileSync('./account-storage.js', 'utf8'), context);
const select = context.window.BabyAccountStorage.select;
store.set('babymode_logs', '[{"date":"2026-09-04"}]');
store.set('babymode_baby_name', 'Миша');
store.set('babymode_web_session_v1', 'not-a-real-token');
store.set('babymode_web_billing_guest_v1', 'not-a-real-billing-secret');
assert.equal(select(101), false, 'first verified account adopts local data');
assert.equal(select('guest'), true);
assert.equal(store.get('babymode_logs'), undefined, 'logout must hide account diary');
assert.equal(store.get('babymode_baby_name'), undefined);
const archived = JSON.parse(store.get('babymode_local_account_v1:101'));
assert.equal(archived.babymode_web_session_v1, undefined);
assert.equal(archived.babymode_web_billing_guest_v1, undefined);
store.set('babymode_baby_name', 'Гость');
assert.equal(select(202), true);
assert.equal(store.get('babymode_logs'), undefined, 'second account cannot upload first diary');
store.set('babymode_baby_name', 'Аня');
assert.equal(select(101), true);
assert.equal(store.get('babymode_baby_name'), 'Миша');
assert.equal(store.get('babymode_logs'), '[{"date":"2026-09-04"}]');
assert.equal(select(101), false);
assert.throws(() => select('../unknown'), /invalid_local_account/);
localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
assert.throws(() => select(202), /QuotaExceededError/);
assert.equal(store.get('babymode_baby_name'), 'Миша', 'failed backup must not erase data');
console.log('ok - local accounts isolate diaries, preserve unsynced records and exclude secrets');

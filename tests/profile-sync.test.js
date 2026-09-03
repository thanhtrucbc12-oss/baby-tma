const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

async function run() {
  const store = new Map();
  const listeners = new Map();
  let requestCount = 0;
  let releasePull;
  let responseSettings = {};
  let authenticated = true;
  let lastPayload;
  const pullGate = new Promise(resolve => { releasePull = resolve; });

  const window = {
    BABY_SYNC_ENDPOINT: 'https://example.test/sync',
    BabyAccount: {
      canUseServer: () => authenticated,
      request: async (_url, options) => {
        requestCount += 1;
        lastPayload = options.body;
        if (options.body.action === 'pull') await pullGate;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            profile: { name: 'Миша', birthdate: '2025-08-20', age_months: 12 },
            profile_updated_at: '2026-09-03T09:00:00.000Z',
            settings: responseSettings,
            settings_updated_at: '2090-01-01T00:00:00.000Z',
            diary: [],
            deleted_diary_days: []
          })
        };
      }
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatchEvent() {}
  };
  const context = {
    window,
    console,
    Date,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    }
  };
  Object.assign(window, context);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('./cloud-sync.js', 'utf8'), context);

  const first = window.BabyCloudSync.syncNow();
  const second = window.BabyCloudSync.syncNow();
  assert.strictEqual(requestCount, 1, 'concurrent startup calls must share the first pull');
  releasePull();
  assert.strictEqual(await first, true);
  assert.strictEqual(await second, true);
  assert.strictEqual(requestCount, 2, 'one pull and one push are expected');
  assert.strictEqual(store.get('babymode_baby_name'), 'Миша');
  assert.strictEqual(store.get('babymode_baby_birthdate'), '2025-08-20');
  store.set('babymode_notif_enabled', 'tg');
  store.set('babymode_ai_consent_v2', 'granted');
  responseSettings = { notifications: true, ai_consent: '', last_age: 1 };
  await window.BabyCloudSync.syncNow();
  assert.strictEqual(lastPayload.settings.notifications, true, 'backend receives boolean reminder preference');
  assert.strictEqual(store.get('babymode_notif_enabled'), 'tg', 'cloud reminder preference keeps the UI format');
  assert.strictEqual(store.get('babymode_ai_consent_v2'), undefined, 'remote consent revocation must be applied');
  assert.strictEqual(store.get('babymode_last_age'), '12', 'old settings cannot overwrite dated profile age');
  responseSettings = { notifications: '0' };
  await window.BabyCloudSync.syncNow();
  assert.strictEqual(store.get('babymode_notif_enabled'), 'no', 'string false must not enable reminders');

  let resolveOld;
  const stale = new Promise(resolve => { resolveOld = resolve; });
  window.BabyAccount.request = async () => { await stale; return { ok: true, json: async () => ({ ok: true, profile: { name: 'STALE' }, profile_updated_at: '2099-01-01' }) }; };
  const oldSync = window.BabyCloudSync.syncNow();
  authenticated = false;
  listeners.get('baby-account-logged-out')();
  resolveOld();
  assert.strictEqual(await oldSync, false);
  assert.strictEqual(store.get('babymode_baby_name'), 'Миша', 'response arriving after logout must be discarded');

  const index = fs.readFileSync('./index.html', 'utf8');
  const onboarding = fs.readFileSync('./onboarding.js', 'utf8');
  const waitIndex = index.indexOf('await BabyCloudSync.syncNow()');
  const onboardingIndex = index.indexOf('initOnboarding()', waitIndex);
  assert.ok(waitIndex >= 0 && onboardingIndex > waitIndex, 'onboarding must start after cloud pull');
  assert.match(onboarding, /Профиль уже получен из Telegram/);
  assert.match(onboarding, /type="hidden" value="\$\{_escapeOnboardingAttribute\(savedName\)\}"/);

  console.log('ok - bot profile is pulled once before Mini App onboarding');
}

run().catch(error => {
  console.error('not ok - bot profile is pulled once before Mini App onboarding');
  console.error(error.stack);
  process.exitCode = 1;
});

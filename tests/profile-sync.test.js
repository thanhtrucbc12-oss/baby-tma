const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

async function run() {
  const store = new Map();
  const listeners = new Map();
  let requestCount = 0;
  let releasePull;
  const pullGate = new Promise(resolve => { releasePull = resolve; });

  const window = {
    BABY_SYNC_ENDPOINT: 'https://example.test/sync',
    BabyAccount: {
      canUseServer: () => true,
      request: async (_url, options) => {
        requestCount += 1;
        if (options.body.action === 'pull') await pullGate;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            profile: { name: 'Миша', birthdate: '2025-08-20', age_months: 12 },
            profile_updated_at: '2026-09-03T09:00:00.000Z',
            settings: {},
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

// Run with NODE_PATH pointing to the installed Playwright package directory.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const output = process.env.QA_OUTPUT || '/private/tmp/baby-mode-qa';
  fs.mkdirSync(output, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Europe/Moscow', reducedMotion: 'reduce' });
    // Never send synthetic profiles, analytics, or payments to production.
    await context.route('**/*.functions.supabase.co/**', route => route.fulfill({
      status: 401, contentType: 'application/json', body: '{"ok":false,"error":"qa_unauthenticated"}'
    }));
    await context.addInitScript(() => {
      if (!localStorage.getItem('qa_seeded')) {
        localStorage.setItem('babymode_onboarded_v2', '1');
        localStorage.setItem('babymode_baby_name', 'Миша');
        localStorage.setItem('babymode_baby_birthdate', '2025-08-20');
        localStorage.setItem('babymode_last_age', '12');
        localStorage.setItem('qa_seeded', '1');
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.QA_URL || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
    await page.locator('#btn-generate').click();
    await page.waitForFunction(() => document.querySelector('#btn-generate').dataset.action !== undefined);
    await page.locator('#homeSleepStart').click();
    assert.equal(await page.locator('#homeSleepStart').isDisabled(), true);
    assert.equal(await page.locator('#homeSleepFinish').isEnabled(), true);
    await page.locator('#homeSleepFinish').click();
    assert.equal(await page.locator('#homeSleepFinish').isDisabled(), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('babymode_logs'))[0].sleepEvents.length), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('babymode_logs'))[0].nightWakings || 0), 0);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('babymode_logs'))[0].sleepEvents.length), 1);

    for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 667 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(viewport);
      for (const name of ['home', 'tracker', 'chat', 'profile']) {
        await page.locator('#bn-' + name).click();
        await page.waitForFunction(id => document.body.dataset.page === id, name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: horizontal overflow at ${viewport.width}`);
        if (name === 'profile') {
          const input = await page.locator('#profileBabyName').boundingBox();
          assert.ok(input.width > 200, 'profile input should use the available width');
          await page.locator('.danger-row').scrollIntoViewIfNeeded();
          const bounds = await page.locator('.danger-row').boundingBox();
          const nav = await page.locator('.bottom-nav').boundingBox();
          assert.ok(bounds.y + bounds.height <= nav.y + 1, 'last profile action must be reachable above nav');
          await page.evaluate(() => scrollTo(0, 0));
        }
        if (viewport.width === 375) await page.screenshot({ path: `${output}/${name}.png` });
      }
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'enlarged text must not cause horizontal overflow');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.locator('#profileBabyName').fill('Александра');
    await page.locator('.profile-form .save-log-btn').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('babymode_baby_name')), 'Александра');
    await page.getByRole('button', { name: /^Premium/ }).click();
    await page.waitForSelector('#page-premium.active');
    assert.match(await page.locator('#page-premium').innerText(), /349/);
    await page.screenshot({ path: `${output}/premium.png` });
    await page.locator('#bn-profile').click();
    await page.getByRole('button', { name: /База знаний Сон/ }).click();
    await page.waitForSelector('#page-articles.active');
    assert.ok((await page.locator('#page-articles').innerText()).length > 100);
    await page.locator('#bn-profile').click();
    await page.getByRole('button', { name: /Ритуал сна Таймер/ }).click();
    await page.waitForSelector('#page-ritual.active');
    assert.ok((await page.locator('#page-ritual').innerText()).length > 100);
    await page.locator('#bn-profile').click();
    await page.getByRole('button', { name: /Партнёрская программа/ }).click();
    await page.waitForSelector('#page-partner.active');
    assert.match(await page.locator('#page-partner').innerText(), /30%/);
    assert.doesNotMatch(await page.locator('#page-partner').innerText(), /62 дня|двух оплат|2 оплат/);
    await page.screenshot({ path: `${output}/partner.png` });
    // Exercise actual session startup + logout + a second user, without Telegram or production.
    await context.route('**/web-auth', route => {
      const action = route.request().postDataJSON()?.action;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(action === 'session'
        ? { ok: true, user: { telegram_id: 202, username: 'synthetic_parent' } }
        : { ok: true }) });
    });
    await page.evaluate(() => {
      BabyAccountStorage.select(101);
      localStorage.setItem('babymode_baby_name', 'Первый');
      localStorage.setItem('babymode_web_session_v1', 'x'.repeat(48));
      localStorage.setItem('babymode_web_session_expiry_v1', '2099-01-01');
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => localStorage.getItem('babymode_local_owner_v1') === '202');
    await page.waitForFunction(() => window.BabyAccount?.isAuthenticated());
    assert.equal(await page.evaluate(() => localStorage.getItem('babymode_logs')), null, 'new account must not inherit diary');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('babymode_local_account_v1:101')).babymode_baby_name), 'Первый');
    // Close first-run onboarding to reach the profile after identity changed.
    await page.evaluate(() => { localStorage.setItem('babymode_onboarded_v2', '1'); document.getElementById('onboarding')?.remove(); });
    await page.locator('#bn-profile').click();
    await page.locator('#profileAccountRow').click();
    await page.waitForFunction(() => localStorage.getItem('babymode_local_owner_v1') === 'guest');
    assert.equal(await page.evaluate(() => localStorage.getItem('babymode_web_session_v1')), null);
    const admin = await context.newPage();
    await admin.goto(new URL('admin.html', process.env.QA_URL || 'http://127.0.0.1:8765/').href, { waitUntil: 'networkidle' });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'admin login fits mobile');
    await admin.close();
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('PASS: sleep start/finish/persistence, profile save, 4 screens x 4 viewports, payment/partner/knowledge/ritual views, account switch/logout, no JS errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const directory = process.env.RELEASE_DIR || '/private/tmp/baby-release';
await fs.mkdir(directory, { recursive: true });
const names = ['analytics-events','sync-data','telegram-webhook','telegram-notifications','yookassa-webhook','yookassa-renewals'];
const files = {};
for (const name of names) {
  const result = await build({ entryPoints:[`supabase/functions/${name}/index.ts`],bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['https://*'],write:false });
  files[name] = result.outputFiles[0].text;
  await fs.writeFile(path.join(directory, name+'.ts'), files[name]);
}
files.migration = (await Promise.all(['20260904010000_integrity_guards.sql','20260904020000_atomic_billing.sql'].map(name=>fs.readFile('supabase/migrations/'+name,'utf8')))).join('\n');
await fs.writeFile(path.join(directory,'migration.sql'),files.migration);
files.smoke = await fs.readFile('tests/production-integrity-smoke.sql','utf8');
files.security = `select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname in ('babies','diary_days','user_app_settings','payments','subscriptions','partner_commissions','notification_settings');
select p.proname,has_function_privilege('anon',p.oid,'execute') as anon_execute,has_function_privilege('authenticated',p.oid,'execute') as user_execute from pg_proc p where p.proname in ('finalize_yookassa_payment','finalize_yookassa_refund','accrue_partner_payment','replace_schedule_reminders','claim_due_schedule_reminders');
select count(*) as rollback_test_rows from public.users where telegram_id=9000000000000123;
select count(*) as eligible_paid_without_commission from public.payments p join public.partner_referrals r on r.billing_identity_id=p.telegram_id left join public.partner_commissions c on c.payment_id=p.id where p.provider='yookassa' and p.status='paid' and p.currency='RUB' and p.paid_at between r.captured_at and r.expires_at and c.id is null;
select trigger,dry_run,planned,sent,failed,completed_at from notification_runs order by completed_at desc limit 5;`;
// Local, loopback-only release clipboard. Contains source code, never credentials.
await fs.writeFile(path.join(directory,'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Baby Mode release files</title><h1>Release files</h1><div id="files"></div><p id="status"></p><textarea aria-label="Release source" rows="10" cols="100"></textarea><script>
const files=${JSON.stringify(files).replaceAll('<','\\u003c')};
for(const [name,text] of Object.entries(files)){const button=document.createElement('button');button.textContent='Copy '+name;button.onclick=()=>{document.querySelector('textarea').value=text;document.getElementById('status').textContent='Selected '+name+' ('+text.length+' characters)';};document.getElementById('files').append(button,document.createElement('br'));}
</script></html>`);
console.log('Built '+names.length+' functions and SQL into '+directory);

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('PostgreSQL integrity: stale writes, atomic billing, retries, refunds, consent and permissions', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    const migrations = [
      '20260614000000_analytics.sql', '20260614010000_notification_settings.sql',
      '20260625010000_subscriptions.sql', '20260720010000_schedule_reminders.sql',
      '20260730010000_launch_hardening.sql', '20260802010000_web_billing_sync.sql',
      '20260821040000_partner_program.sql', '20260822010000_partner_two_payments.sql',
      '20260904010000_integrity_guards.sql', '20260904020000_atomic_billing.sql'
    ];
    for (const name of migrations) {
      let sql = fs.readFileSync(`supabase/migrations/${name}`, 'utf8');
      // PGlite has core gen_random_uuid but no hosted cron/network extensions.
      sql = sql.replace('create extension if not exists pgcrypto;', '');
      if (name === '20260802010000_web_billing_sync.sql') sql = sql.split('select cron.unschedule')[0];
      await db.exec(sql);
    }
    const uid = '11111111-1111-4111-8111-111111111111';
    const pid = '22222222-2222-4222-8222-222222222222';
    const rid = '33333333-3333-4333-8333-333333333333';
    const paymentId = '44444444-4444-4444-8444-444444444444';
    await db.query('insert into users(id,telegram_id) values($1,123)', [uid]);
    await db.query("insert into babies(user_id,name,updated_at) values($1,'NEW','2026-09-04T10:00Z')", [uid]);
    await db.query("insert into babies(user_id,name,updated_at) values($1,'OLD','2026-09-04T09:00Z') on conflict(user_id) do update set name=excluded.name,updated_at=excluded.updated_at", [uid]);
    assert.equal((await db.query('select name from babies')).rows[0].name, 'NEW');
    await db.query("insert into diary_days(user_id,telegram_id,entry_date,data,client_updated_at) values($1,123,'2026-09-04','{\"note\":\"NEW\"}','2026-09-04T10:00Z')", [uid]);
    await db.query("insert into diary_days(user_id,telegram_id,entry_date,data,client_updated_at) values($1,123,'2026-09-04','{\"note\":\"OLD\"}','2026-09-04T09:00Z') on conflict(user_id,entry_date) do update set data=excluded.data,client_updated_at=excluded.client_updated_at", [uid]);
    assert.equal((await db.query('select data from diary_days')).rows[0].data.note, 'NEW');
    await db.query("insert into user_app_settings(user_id,telegram_id,settings,client_updated_at) values($1,123,'{\"wake_time\":\"08:00\"}','2026-09-04T10:00Z')", [uid]);
    await db.exec("update user_app_settings set settings='{}',client_updated_at='2026-09-04T09:00Z'");
    assert.equal((await db.query('select settings from user_app_settings')).rows[0].settings.wake_time, '08:00');
    await db.query("insert into partners(id,code,name) values($1,'test-partner','Synthetic partner')", [pid]);
    await db.query("insert into partner_referrals(id,partner_id,user_id,billing_identity_id,source,code,captured_at,expires_at) values($1,$2,$3,123,'web_checkout','test-partner',now()-interval '1 day',now()+interval '29 days')", [rid,pid,uid]);
    await db.query("insert into payments(id,user_id,telegram_id,invoice_payload,plan,currency,total_amount,provider) values($1,$2,123,'test-payment','month','RUB',34900,'yookassa')", [paymentId,uid]);
    const payment = { id:'synthetic-provider', status:'succeeded', paid:true, metadata:{internal_payment_id:paymentId,telegram_id:'123',plan:'month'}, amount:{currency:'RUB',value:'349.00'} };
    const pay = () => db.query('select finalize_yookassa_payment($1,$2,$3) as result', [paymentId,JSON.stringify(payment),'synthetic-cipher']);
    // Inject failures into actual SQL writes, not into an emulated query builder.
    await db.exec(`create function fail_for_test() returns trigger language plpgsql as $$ begin
      if current_setting('baby.fail_table',true)=TG_TABLE_NAME then raise exception 'synthetic_failure'; end if;
      return new; end; $$;
      create trigger subscription_failure before insert or update on subscriptions for each row execute function fail_for_test();
      create trigger commission_failure before insert or update on partner_commissions for each row execute function fail_for_test();`);
    for (const table of ['subscriptions', 'partner_commissions']) {
      await db.query("select set_config('baby.fail_table',$1,false)", [table]);
      await assert.rejects(pay(), /synthetic_failure/);
      assert.equal((await db.query('select status from payments')).rows[0].status, 'created');
      assert.equal((await db.query('select count(*)::int as n from billing_agreements')).rows[0].n, 0);
    }
    await db.exec("select set_config('baby.fail_table','',false)");
    const first = (await pay()).rows[0].result;
    const repeat = (await pay()).rows[0].result;
    assert.equal(repeat.current_period_end, first.current_period_end);
    assert.equal(repeat.newly_paid, false);
    assert.equal((await db.query('select commission_minor from partner_commissions')).rows[0].commission_minor, 10470);
    const refund = {id:'synthetic-refund',payment_id:payment.id,status:'succeeded',amount:{currency:'RUB',value:'349.00'}};
    const refundPayment = () => db.query('select finalize_yookassa_refund($1,$2,true)',[paymentId,JSON.stringify(refund)]);
    await db.exec("select set_config('baby.fail_table','subscriptions',false)");
    await assert.rejects(refundPayment(), /synthetic_failure/);
    assert.equal((await db.query('select status from payments')).rows[0].status, 'paid');
    assert.equal((await db.query('select status from partner_commissions')).rows[0].status, 'pending');
    assert.equal((await db.query("select count(*)::int as n from billing_events where status='processed'")).rows[0].n, 0);
    await db.exec("select set_config('baby.fail_table','',false)");
    await refundPayment(); await refundPayment();
    assert.equal((await db.query('select status from subscriptions')).rows[0].status, 'revoked');
    assert.equal((await db.query('select status from partner_commissions')).rows[0].status, 'reversed');
    assert.equal((await pay()).rows[0].result.ignored, true, 'late succeeded cannot restore refunded access');

    await db.query("insert into notification_settings(user_id,telegram_id,chat_id,enabled,schedule_reminders,updated_at) values($1,123,123,true,true,'2026-09-04T10:00Z')", [uid]);
    await db.query("insert into schedule_reminders(user_id,telegram_id,chat_id,reminder_key,reminder_type,title,message,scheduled_at) values($1,123,123,'test','sleep','test','test',now()-interval '1 minute')", [uid]);
    assert.equal((await db.query('select * from claim_due_schedule_reminders()')).rows.length, 0, 'no active premium');
    await db.exec("update subscriptions set status='active',current_period_end=now()+interval '1 day'");
    assert.equal((await db.query('select * from claim_due_schedule_reminders()')).rows.length, 1);
    await db.exec("update notification_settings set enabled=false,updated_at='2026-09-04T11:00Z'");
    assert.equal((await db.query('select status from schedule_reminders')).rows[0].status, 'cancelled');
    await db.exec("update notification_settings set enabled=true,updated_at='2026-09-04T09:00Z'");
    assert.equal((await db.query('select enabled from notification_settings')).rows[0].enabled, false);
    for (const signature of ['finalize_yookassa_payment(uuid,jsonb,text)','finalize_yookassa_refund(uuid,jsonb,boolean)','accrue_partner_payment(uuid)','claim_due_schedule_reminders(integer)']) {
      assert.equal((await db.query("select has_function_privilege('anon',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed, false);
      assert.equal((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed, false);
    }
  } finally { await db.close(); }
});

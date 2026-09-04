-- Synthetic database-only checks. No Telegram/API calls. Always ROLLBACK.
begin;
do $$
declare
  u uuid := gen_random_uuid();
  partner_id_value uuid := gen_random_uuid();
  payment_id_value uuid := gen_random_uuid();
  identity_value bigint := 9000000000000123;
  payload jsonb;
  first_result jsonb;
  repeat_result jsonb;
  actual text;
begin
  insert into public.users(id,telegram_id) values(u,identity_value);
  insert into public.babies(user_id,name,updated_at) values(u,'QA_NEW',now());
  update public.babies set name='QA_OLD',updated_at=now()-interval '1 day' where user_id=u;
  select name into actual from public.babies where user_id=u;
  if actual <> 'QA_NEW' then raise exception 'profile_version_guard_failed'; end if;
  insert into public.diary_days(user_id,telegram_id,entry_date,data,client_updated_at)
    values(u,identity_value,current_date,'{"note":"NEW"}',now());
  update public.diary_days set data='{"note":"OLD"}',client_updated_at=now()-interval '1 day' where user_id=u;
  select data->>'note' into actual from public.diary_days where user_id=u;
  if actual <> 'NEW' then raise exception 'diary_version_guard_failed'; end if;
  insert into public.partners(id,code,name) values(partner_id_value,'qa_'||left(replace(partner_id_value::text,'-',''),20),'Synthetic rollback check');
  insert into public.partner_referrals(partner_id,user_id,billing_identity_id,source,code,captured_at,expires_at)
    values(partner_id_value,u,identity_value,'web_checkout','qa_test',now()-interval '1 day',now()+interval '29 days');
  insert into public.payments(id,user_id,telegram_id,invoice_payload,plan,currency,total_amount,provider)
    values(payment_id_value,u,identity_value,'qa_'||payment_id_value::text,'month','RUB',34900,'yookassa');
  payload := jsonb_build_object('id','qa_provider_'||payment_id_value::text,'status','succeeded','paid',true,
    'metadata',jsonb_build_object('internal_payment_id',payment_id_value::text,'telegram_id',identity_value::text,'plan','month'),
    'amount',jsonb_build_object('currency','RUB','value','349.00'));
  first_result := public.finalize_yookassa_payment(payment_id_value,payload,'synthetic-not-a-secret');
  repeat_result := public.finalize_yookassa_payment(payment_id_value,payload,'synthetic-not-a-secret');
  if first_result->>'current_period_end' <> repeat_result->>'current_period_end' then raise exception 'duplicate_extended_access'; end if;
  if (select count(*) from public.partner_commissions where payment_id=payment_id_value) <> 1 then raise exception 'commission_not_exactly_once'; end if;
  perform public.finalize_yookassa_refund(payment_id_value,jsonb_build_object('id','qa_refund_'||payment_id_value::text,
    'payment_id',payload->>'id','status','succeeded','amount',jsonb_build_object('currency','RUB','value','349.00')),true);
  select status into actual from public.subscriptions where telegram_id=identity_value;
  if actual <> 'revoked' then raise exception 'refund_did_not_revoke'; end if;
  select status into actual from public.partner_commissions where payment_id=payment_id_value;
  if actual <> 'reversed' then raise exception 'refund_did_not_reverse_commission'; end if;
  if not (public.finalize_yookassa_payment(payment_id_value,payload,'synthetic-not-a-secret')->>'ignored')::boolean then raise exception 'refunded_payment_reactivated'; end if;
  if has_function_privilege('anon','public.finalize_yookassa_payment(uuid,jsonb,text)','execute')
    or has_function_privilege('authenticated','public.finalize_yookassa_refund(uuid,jsonb,boolean)','execute') then raise exception 'unsafe_function_permissions'; end if;
end;
$$;
rollback;

begin;
create or replace function public.finalize_yookassa_payment(p_id uuid, p_payment jsonb, p_ciphertext text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.payments%rowtype;
  s public.subscriptions%rowtype;
  a public.billing_agreements%rowtype;
  start_at timestamptz;
  end_at timestamptz;
  fresh boolean;
  recurring boolean;
  cancelled boolean;
  method_type text;
begin
  select * into p from public.payments where id = p_id and provider = 'yookassa';
  if not found then raise exception 'payment_not_found'; end if;
  perform pg_advisory_xact_lock(p.telegram_id);
  select * into p from public.payments where id = p_id for update;
  if p_payment->>'status' <> 'succeeded' or (p_payment->>'paid')::boolean is distinct from true
    or p_payment#>>'{metadata,internal_payment_id}' <> p.id::text
    or p_payment#>>'{metadata,telegram_id}' <> p.telegram_id::text
    or p_payment#>>'{metadata,plan}' <> p.plan
    or p_payment#>>'{amount,currency}' <> 'RUB' or p.currency <> 'RUB'
    or round((p_payment#>>'{amount,value}')::numeric * 100) <> p.total_amount
    or (p.external_payment_id is not null and p.external_payment_id <> p_payment->>'id') then
    raise exception 'payment_mismatch';
  end if;
  if p.status in ('refunded', 'partially_refunded') then return jsonb_build_object('ignored', true); end if;
  select * into s from public.subscriptions where telegram_id = p.telegram_id for update;
  select * into a from public.billing_agreements where provider = 'yookassa' and telegram_id = p.telegram_id for update;
  fresh := p.status <> 'paid';
  if fresh then
    start_at := greatest(now(), coalesce(s.current_period_end, now()));
    end_at := start_at + make_interval(months => case p.plan when 'month' then 1 when 'quarter' then 3 else null end);
    if end_at is null then raise exception 'invalid_plan'; end if;
    update public.payments set status = 'paid', external_payment_id = p_payment->>'id',
      provider_payment_charge_id = p_payment->>'id', raw_payload = p_payment, paid_at = now(),
      access_period_start = start_at, access_period_end = end_at, updated_at = now(), error_code = null where id = p.id;
  else
    start_at := p.access_period_start; end_at := p.access_period_end;
  end if;
  if start_at is null or end_at is null then raise exception 'payment_period_missing'; end if;
  recurring := coalesce((p_payment#>>'{payment_method,saved}')::boolean, false)
    and p_payment#>>'{payment_method,type}' is not null;
  cancelled := not recurring or coalesce(a.cancel_at_period_end, false) or coalesce(a.status = 'cancelled', false);
  method_type := case when recurring then left(p_payment#>>'{payment_method,type}',40) else 'one_time' end;
  -- A late duplicate may repair commission, but must never shorten newer access.
  if fresh or a.last_payment_id = p_payment->>'id' or coalesce(a.current_period_end, '-infinity') < end_at then
    insert into public.billing_agreements(user_id,telegram_id,provider,plan,status,amount_minor,currency,
      payment_method_ciphertext,payment_method_type,next_charge_at,current_period_end,cancel_at_period_end,last_payment_id)
    values(p.user_id,p.telegram_id,'yookassa',p.plan,case when cancelled then 'cancelled' else 'active' end,p.total_amount,'RUB',
      p_ciphertext,method_type,end_at,end_at,cancelled,p_payment->>'id')
    on conflict(provider,telegram_id) do update set plan=excluded.plan,status=excluded.status,
      amount_minor=excluded.amount_minor,payment_method_ciphertext=excluded.payment_method_ciphertext,
      payment_method_type=excluded.payment_method_type,next_charge_at=excluded.next_charge_at,
      current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,
      last_payment_id=excluded.last_payment_id,retry_count=0,last_error=null,updated_at=now();
    insert into public.subscriptions(user_id,telegram_id,plan,status,source,current_period_start,current_period_end,
      cancel_at_period_end,next_billing_at,last_payment_at,payment_method_type)
    values(p.user_id,p.telegram_id,p.plan,'active','yookassa',start_at,end_at,cancelled,
      case when cancelled then null else end_at end,coalesce(p.paid_at,now()),method_type)
    on conflict(telegram_id) do update set plan=excluded.plan,status=excluded.status,source=excluded.source,
      current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
      cancel_at_period_end=excluded.cancel_at_period_end,next_billing_at=excluded.next_billing_at,
      last_payment_at=excluded.last_payment_at,payment_method_type=excluded.payment_method_type,last_error=null,updated_at=now()
    where public.subscriptions.current_period_end <= excluded.current_period_end;
  end if;
  perform public.accrue_partner_payment(p.id);
  return jsonb_build_object('newly_paid',fresh,'current_period_end',end_at,'paid_at',coalesce(p.paid_at,now()),'recurring',recurring);
end;
$$;
revoke all on function public.finalize_yookassa_payment(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.finalize_yookassa_payment(uuid,jsonb,text) to service_role;

create or replace function public.accrue_partner_payment(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.payments%rowtype;
  r public.partner_referrals%rowtype;
  partner public.partners%rowtype;
  c public.partner_commissions%rowtype;
  n integer;
  at_time timestamptz;
begin
  select * into p from public.payments where id=p_id;
  if not found then raise exception 'payment_not_found'; end if;
  perform pg_advisory_xact_lock(p.telegram_id);
  select * into p from public.payments where id=p_id;
  if p.status <> 'paid' or p.currency <> 'RUB' then return null; end if;
  select * into r from public.partner_referrals where billing_identity_id=p.telegram_id for update;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.partner_id::text,0));
  select * into c from public.partner_commissions where payment_id=p.id;
  if found then return to_jsonb(c); end if;
  select * into partner from public.partners where id=r.partner_id;
  at_time := coalesce(p.paid_at,now());
  select count(*) into n from public.partner_commissions where referral_id=r.id;
  if n >= partner.commission_payment_limit or r.captured_at > at_time
    or (n=0 and r.expires_at < at_time)
    or (n>0 and (r.commission_ends_at is null or r.commission_ends_at < at_time))
    or partner.commission_bps <= 0 then return null; end if;
  if n=0 then
    update public.partner_referrals set converted_at=at_time,
      commission_ends_at=at_time+make_interval(days=>partner.commission_days) where id=r.id;
  end if;
  insert into public.partner_commissions(partner_id,referral_id,payment_id,amount_minor,commission_bps,
    commission_minor,payment_number,currency,status,available_at)
  values(partner.id,r.id,p.id,p.total_amount,partner.commission_bps,
    floor(p.total_amount::numeric*partner.commission_bps/10000)::integer,n+1,'RUB','pending',
    at_time+make_interval(days=>partner.hold_days)) returning * into c;
  return to_jsonb(c);
end;
$$;
revoke all on function public.accrue_partner_payment(uuid) from public,anon,authenticated;
grant execute on function public.accrue_partner_payment(uuid) to service_role;

create or replace function public.finalize_yookassa_refund(p_id uuid, p_refund jsonb, p_full boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.payments%rowtype;
  s public.subscriptions%rowtype;
  a public.billing_agreements%rowtype;
  event_key_value text := 'refund.succeeded:' || (p_refund->>'id');
  partner_id_value uuid;
begin
  select * into p from public.payments where id=p_id and provider='yookassa';
  if not found then raise exception 'payment_not_found'; end if;
  perform pg_advisory_xact_lock(p.telegram_id);
  select * into p from public.payments where id=p_id for update;
  if p_refund->>'payment_id' is distinct from p.external_payment_id
    or p_refund->>'status' is distinct from 'succeeded' then raise exception 'refund_mismatch'; end if;
  if exists(select 1 from public.billing_events where provider='yookassa' and event_key=event_key_value and status='processed') then return; end if;
  insert into public.billing_events(provider,event_key,event_type,status,external_payment_id,payload)
    values('yookassa',event_key_value,'refund.succeeded','processing',p.external_payment_id,p_refund)
    on conflict(provider,event_key) do update set status='processing',payload=excluded.payload,error=null;
  update public.payments set status=case when p_full or status='refunded' then 'refunded' else 'partially_refunded' end,
    updated_at=now() where id=p.id;
  if p_full then
    select partner_id into partner_id_value from public.partner_referrals where billing_identity_id=p.telegram_id;
    if partner_id_value is not null then perform pg_advisory_xact_lock(hashtextextended(partner_id_value::text,0)); end if;
    update public.partner_commissions set status='reversed',reversed_at=now(),updated_at=now()
      where payment_id=p.id and status<>'reversed';
    select * into s from public.subscriptions where telegram_id=p.telegram_id for update;
    select * into a from public.billing_agreements where provider='yookassa' and telegram_id=p.telegram_id for update;
    if a.last_payment_id=p.external_payment_id and s.source='yookassa'
      and abs(extract(epoch from s.current_period_end-p.access_period_end)) <= 1 then
      update public.billing_agreements set status='cancelled',cancel_at_period_end=true,
        current_period_end=p.access_period_start,next_charge_at=p.access_period_start,updated_at=now() where id=a.id;
      update public.subscriptions set status=case when p.access_period_start > now() then 'active' else 'revoked' end,
        cancel_at_period_end=true,current_period_end=p.access_period_start,next_billing_at=null,updated_at=now()
        where telegram_id=p.telegram_id;
    end if;
  end if;
  update public.billing_events set status='processed',processed_at=now(),error=null
    where provider='yookassa' and event_key=event_key_value;
end;
$$;
revoke all on function public.finalize_yookassa_refund(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.finalize_yookassa_refund(uuid,jsonb,boolean) to service_role;
commit;

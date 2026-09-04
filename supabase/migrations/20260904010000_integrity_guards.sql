begin;

alter table public.notification_settings add column if not exists schedule_updated_at timestamptz;

create or replace function public.replace_schedule_reminders(p_telegram_id bigint, p_at timestamptz, p_items jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare n public.notification_settings%rowtype;
begin
  select * into n from public.notification_settings where telegram_id=p_telegram_id for update;
  if not found or not n.enabled or not n.schedule_reminders then return false; end if;
  if p_at is null or p_at > now()+interval '5 minutes' or p_at <= coalesce(n.schedule_updated_at,'-infinity') then return false; end if;
  if not exists(select 1 from public.subscriptions where telegram_id=p_telegram_id and status='active' and current_period_end>now()) then return false; end if;
  update public.schedule_reminders set status='cancelled'
    where telegram_id=p_telegram_id and status='pending' and scheduled_at>=now();
  insert into public.schedule_reminders(user_id,telegram_id,chat_id,reminder_key,reminder_type,title,message,scheduled_at,status)
    select n.user_id,p_telegram_id,p_telegram_id,left(item->>'reminder_key',120),left(item->>'reminder_type',30),
      left(item->>'title',120),left(item->>'message',500),(item->>'scheduled_at')::timestamptz,'pending'
    from jsonb_array_elements(p_items) with ordinality as x(item,position)
    where position<=16 and (item->>'scheduled_at')::timestamptz between now() and now()+interval '24 hours'
    on conflict(telegram_id,reminder_key,scheduled_at) do update set status='pending',message=excluded.message,title=excluded.title
      where public.schedule_reminders.status in ('pending','cancelled');
  update public.notification_settings set schedule_updated_at=p_at where id=n.id;
  return true;
end;
$$;
revoke all on function public.replace_schedule_reminders(bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.replace_schedule_reminders(bigint,timestamptz,jsonb) to service_role;

-- BEFORE UPDATE sees the locked, current row, including ON CONFLICT updates.
create or replace function public.reject_stale_client_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if (to_jsonb(new)->>tg_argv[0])::timestamptz < (to_jsonb(old)->>tg_argv[0])::timestamptz then
    return null;
  end if;
  return new;
end;
$$;

create trigger babies_version_guard before update on public.babies
  for each row execute function public.reject_stale_client_write('updated_at');
create trigger diary_version_guard before update on public.diary_days
  for each row execute function public.reject_stale_client_write('client_updated_at');
create trigger settings_version_guard before update on public.user_app_settings
  for each row execute function public.reject_stale_client_write('client_updated_at');
create trigger notifications_version_guard before update on public.notification_settings
  for each row execute function public.reject_stale_client_write('updated_at');

create or replace function public.cancel_disabled_reminders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.enabled or not new.schedule_reminders then
    update public.schedule_reminders set status = 'cancelled'
      where telegram_id = new.telegram_id and status in ('pending', 'processing', 'failed');
  end if;
  return new;
end;
$$;
create trigger notifications_cancel_queue after insert or update on public.notification_settings
  for each row execute function public.cancel_disabled_reminders();

create or replace function public.claim_due_schedule_reminders(p_limit integer default 100)
returns setof public.schedule_reminders language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select r.id from public.schedule_reminders r
    where (r.status = 'pending'
      or (r.status = 'failed' and r.attempts < 3 and r.claimed_at < now() - interval '5 minutes')
      or (r.status = 'processing' and r.claimed_at < now() - interval '15 minutes'))
      and r.scheduled_at between now() - interval '6 hours' and now()
      and exists (select 1 from public.notification_settings n
        where n.telegram_id = r.telegram_id and n.enabled and n.schedule_reminders)
      and exists (select 1 from public.subscriptions s
        where s.telegram_id = r.telegram_id and s.status = 'active' and s.current_period_end > now())
    order by r.scheduled_at for update of r skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 500)))
  update public.schedule_reminders r set status = 'processing', claimed_at = now(),
    attempts = r.attempts + 1, error = null
    from due where r.id = due.id returning r.*;
end;
$$;
revoke all on function public.reject_stale_client_write() from public, anon, authenticated;
revoke all on function public.cancel_disabled_reminders() from public, anon, authenticated;
revoke all on function public.claim_due_schedule_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_due_schedule_reminders(integer) to service_role;

commit;

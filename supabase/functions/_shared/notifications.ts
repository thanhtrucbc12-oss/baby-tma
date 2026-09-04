export async function saveNotificationPreference(supabase: any, auth: any, preference: any, updatedAt: string) {
  if (typeof preference?.enabled !== 'boolean' || !(auth.telegramId > 0)) return;
  const { data: current, error: readError } = await supabase.from('notification_settings')
    .select('timezone,updated_at').eq('telegram_id', auth.telegramId).maybeSingle();
  if (readError) throw readError;
  if (current && new Date(current.updated_at) > new Date(updatedAt)) return;
  let timezone = current?.timezone || 'Europe/Moscow';
  if (typeof preference.timezone === 'string') {
    try { new Intl.DateTimeFormat('en', { timeZone: preference.timezone }); timezone = preference.timezone; } catch (_) {}
  }
  const { error } = await supabase.from('notification_settings').upsert({
    user_id: auth.user.id, telegram_id: auth.telegramId, chat_id: auth.telegramId,
    enabled: preference.enabled, birthday_reminders: preference.enabled,
    age_milestones: preference.enabled, schedule_reminders: preference.enabled,
    timezone, updated_at: updatedAt
  }, { onConflict: 'telegram_id' });
  if (error) throw error;
}

export async function canSendReminder(supabase: any, telegramId: number, kind = 'schedule') {
  const { data: setting, error } = await supabase.from('notification_settings')
    .select('enabled,schedule_reminders,birthday_reminders,age_milestones')
    .eq('telegram_id', telegramId).maybeSingle();
  if (error) throw error;
  if (!setting?.enabled) return false;
  if (kind !== 'schedule') return Boolean(kind === 'birthday' ? setting.birthday_reminders : setting.age_milestones);
  if (!setting.schedule_reminders) return false;
  const { data: sub, error: subError } = await supabase.from('subscriptions')
    .select('status,current_period_end').eq('telegram_id', telegramId).maybeSingle();
  if (subError) throw subError;
  return sub?.status === 'active' && new Date(sub.current_period_end).getTime() > Date.now();
}

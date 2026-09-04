(function(global) {
  'use strict';
  const OWNER = 'babymode_local_owner_v1';
  const PREFIX = 'babymode_local_account_v1:';
  // Explicit allowlist: never archive login tokens, billing secrets or analytics.
  const KEYS = [
    'baby_name', 'baby_birthdate', 'photo', 'last_age', 'wake_time', 'feed_type',
    'logs', 'diary_tombstones_v1', 'settings_updated_at_v1', 'profile_updated_at_v1',
    'today_schedule_v1', 'quick_sleep_start', 'last_diary_mutation_v1', 'tomorrow_plan',
    'notif_enabled', 'notification_updated_at_v1', 'today_reminders', 'ai_consent_v2', 'premium', 'premium_until',
    'trial_start', 'personal_plan_ready_v1', 'last_backup_at', 'last_backup_restore',
    'onboarded_v2', 'launched', 'gen_count'
  ].map(key => 'babymode_' + key);

  function select(identity) {
    const owner = String(identity || '');
    if (!/^(guest|[1-9]\d*)$/.test(owner)) throw new Error('invalid_local_account');
    const previous = localStorage.getItem(OWNER);
    if (previous === owner) return false;
    if (previous) {
      const stored = localStorage.getItem(PREFIX + owner);
      const next = stored ? JSON.parse(stored) : {};
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('invalid_local_backup');
      const snapshot = {};
      for (const key of KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) snapshot[key] = value;
      }
      // Save successfully before replacing any active data (e.g. storage quota).
      localStorage.setItem(PREFIX + previous, JSON.stringify(snapshot));
      for (const key of KEYS) localStorage.removeItem(key);
      for (const key of KEYS) {
        if (typeof next[key] === 'string') localStorage.setItem(key, next[key]);
      }
    }
    localStorage.setItem(OWNER, owner);
    localStorage.removeItem('babymode_analytics_queue');
    return Boolean(previous);
  }

  global.BabyAccountStorage = { select };
})(window);

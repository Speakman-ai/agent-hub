import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SECTIONS,
  type NotificationChannel,
} from '@shared/utils/notificationCategories';
import type { NotificationPreferencesPatch } from '../utils/api';
import {
  getSnapshot,
  loadNotificationPrefs,
  saveNotificationPrefs,
  subscribe,
} from '../utils/notificationPrefsStore';

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  desktop: 'Desktop',
  push: 'Push',
};

function Toggle({
  checked,
  onChange,
  label,
  testId,
  disabled = false,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-blue-600' : 'bg-gray-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default function NotificationPreferencesSection() {
  const { loaded, loading, error, prefs } = useSyncExternalStore(subscribe, getSnapshot);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const editable = loaded;
  const save = saveNotificationPrefs;

  useEffect(() => {
    loadNotificationPrefs();
  }, []);

  return (
    <div className="space-y-4" data-testid="notification-preferences">
      <div>
        <h3 className="text-lg font-semibold">Notifications</h3>
        <p className="text-sm text-gray-400">
          Choose how you hear about each kind of event. These settings apply to every device you
          sign in on.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300"
        >
          {error}
          {!loaded && !loading && (
            <button
              type="button"
              onClick={() => loadNotificationPrefs()}
              className="ml-2 underline hover:text-red-200"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading preferences…
        </div>
      )}

      {NOTIFICATION_SECTIONS.map((section) => {
        const ids = section.categories.map((c) => c.id as string);
        const allOn = ids.every((id) => NOTIFICATION_CHANNELS.every((ch) => prefs[id]?.[ch]));
        return (
          <section
            key={section.id}
            className="rounded-lg border border-gray-800 bg-gray-900/40"
            data-testid={`notification-section-${section.id}`}
          >
            <header className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
              <h4 className="text-sm font-semibold text-gray-200">{section.label}</h4>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                Enable all
                <Toggle
                  checked={allOn}
                  label={`Enable all ${section.label} notifications`}
                  testId={`notification-section-all-${section.id}`}
                  disabled={!editable}
                  onChange={(value) => {
                    const patch: NotificationPreferencesPatch = {};
                    for (const id of ids) {
                      patch[id] = { in_app: value, desktop: value, push: value };
                    }
                    save(patch);
                  }}
                />
              </label>
            </header>
            <ul className="divide-y divide-gray-800">
              {section.categories.map((cat) => {
                const values = prefs[cat.id];
                const open = !!expanded[cat.id];
                const on = NOTIFICATION_CHANNELS.filter((ch) => values?.[ch]).map(
                  (ch) => CHANNEL_LABELS[ch],
                );
                return (
                  <li key={cat.id} data-testid={`notification-category-${cat.id}`}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpanded((cur) => ({ ...cur, [cat.id]: !open }))}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/40"
                    >
                      {open ? (
                        <ChevronDown size={14} className="text-gray-500" />
                      ) : (
                        <ChevronRight size={14} className="text-gray-500" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-200">{cat.label}</div>
                        <div className="text-xs text-gray-500">{cat.description}</div>
                      </div>
                      <span className="shrink-0 text-xs text-gray-500">
                        {on.length ? on.join(', ') : 'Off'}
                      </span>
                    </button>
                    {open && (
                      <div className="space-y-2 px-11 pb-3">
                        {NOTIFICATION_CHANNELS.map((ch) => (
                          <div key={ch} className="flex items-center justify-between text-sm">
                            <span className="text-gray-300">{CHANNEL_LABELS[ch]}</span>
                            <Toggle
                              checked={!!values?.[ch]}
                              label={`${cat.label}: ${CHANNEL_LABELS[ch]}`}
                              testId={`notification-toggle-${cat.id}-${ch}`}
                              disabled={!editable}
                              onChange={(value) => save({ [cat.id]: { [ch]: value } })}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

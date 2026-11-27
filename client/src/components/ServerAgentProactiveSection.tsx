import { useCallback, useEffect, useRef, useState } from 'react';
import { ProactivePrefsQueue, type ProactivePrefsPatch } from '@shared/utils/proactivePrefsQueue';
import { api } from '../utils/api';
import {
  PROACTIVE_AREAS,
  PROACTIVE_AREA_LABELS,
  PROACTIVE_INTERVAL_HOURS,
  PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT,
  type ServerAgentProactivePrefs,
} from '@shared/utils/serverAgentProactive';

type Suppression = Awaited<
  ReturnType<typeof api.listServerAgentSuppressions>
>['suppressions'][number];

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const CHECK_STATUS_COPY: Record<string, string> = {
  ok: 'ran',
  empty: 'found nothing to offer',
  unchanged: 'nothing changed since the last check',
  quiet: 'held for quiet hours',
  capped: 'daily offer limit reached',
  error: 'failed',
};

/**
 * Proactive mode settings: the Server Agent checks in on a schedule (and on
 * urgent events) and offers to do work. Each change saves immediately.
 */
export function ServerAgentProactiveSection({
  enabled: formEnabled = true,
}: {
  enabled?: boolean;
}) {
  const [prefs, setPrefs] = useState<ServerAgentProactivePrefs | null>(null);
  const [state, setState] = useState<{
    lastCheckAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
  } | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // Saves go through one serialized queue: each change sends only its own
  // field, and the form shows confirmed state plus pending changes.
  const queueRef = useRef<ProactivePrefsQueue | null>(null);
  // Rules removed here; a reload that started before the removal must not
  // bring them back.
  const removedRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api.getServerAgentProactive(),
        api.listServerAgentSuppressions(),
      ]);
      // Later reloads (after Check now) refresh status only; the queue owns prefs.
      if (!queueRef.current) {
        queueRef.current = new ProactivePrefsQueue(
          p.prefs,
          async (patch) => (await api.putServerAgentProactive(patch)).prefs,
          (q) => {
            setPrefs(q.prefs);
            if (q.error) setStatus({ ok: false, text: q.error });
            else if (q.saved && !q.saving) setStatus({ ok: true, text: 'Saved' });
          },
        );
        setPrefs(p.prefs);
      }
      setState(p.state);
      setSuppressions(s.suppressions.filter((x) => !removedRef.current.has(x.id)));
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Could not load.' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = (patch: ProactivePrefsPatch) => {
    queueRef.current?.enqueue(patch);
  };

  const toggleEnabled = (on: boolean) => {
    // First opt-in adopts the browser's zone so quiet hours mean local time.
    const patch: ProactivePrefsPatch = { enabled: on };
    if (on && prefs?.timeZone === 'UTC' && browserTimeZone() !== 'UTC') {
      patch.timeZone = browserTimeZone();
    }
    save(patch);
  };

  const removeSuppression = async (id: string) => {
    try {
      await api.deleteServerAgentSuppression(id);
      removedRef.current.add(id);
      setSuppressions((list) => list.filter((s) => s.id !== id));
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Could not remove.' });
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const res = await api.runServerAgentProactiveCheck();
      setStatus({
        ok: res.status !== 'error',
        text:
          res.status === 'ok'
            ? `${res.offers.length} new offer${res.offers.length === 1 ? '' : 's'}`
            : res.error || CHECK_STATUS_COPY[res.status] || res.status,
      });
      void load();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : 'Check failed.' });
    } finally {
      setChecking(false);
    }
  };

  if (!prefs) return null;
  const disabled = !formEnabled;
  const fieldsDisabled = disabled || !prefs.enabled;

  return (
    <section
      className="space-y-3 border-t border-gray-800 pt-4"
      data-testid="server-agent-proactive"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Proactive mode</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            The agent checks in on its own and offers to help: failed Finalize runs, sessions
            waiting on you, emails needing a reply, firing alerts, overdue todos. You choose Do it,
            Not now, or Never for that kind. It starts sessions and changes Hub data only after you
            accept; sending, deleting and merging still ask first.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={prefs.enabled}
            disabled={disabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
            data-testid="server-agent-proactive-enabled"
          />
          On
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-gray-400">
          Check in every
          <select
            value={prefs.intervalHours}
            disabled={fieldsDisabled}
            onChange={(e) => save({ intervalHours: Number(e.target.value) })}
            data-testid="server-agent-proactive-interval"
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white"
          >
            {PROACTIVE_INTERVAL_HOURS.map((h) => (
              <option key={h} value={h}>
                {h === 1 ? '1 hour' : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-gray-400">
          Max offers per day
          <input
            type="number"
            min={1}
            max={PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT}
            value={prefs.maxOffersPerDay}
            disabled={fieldsDisabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT) save({ maxOffersPerDay: n });
            }}
            data-testid="server-agent-proactive-max"
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.quietHours.enabled}
            disabled={fieldsDisabled}
            onChange={(e) => save({ quietHours: { enabled: e.target.checked } })}
            data-testid="server-agent-proactive-quiet"
          />
          Quiet hours
        </label>
        <input
          type="time"
          value={prefs.quietHours.start}
          disabled={fieldsDisabled || !prefs.quietHours.enabled}
          onChange={(e) => e.target.value && save({ quietHours: { start: e.target.value } })}
          className="rounded border border-gray-700 bg-gray-900 px-1.5 py-1 text-white"
        />
        <span>to</span>
        <input
          type="time"
          value={prefs.quietHours.end}
          disabled={fieldsDisabled || !prefs.quietHours.enabled}
          onChange={(e) => e.target.value && save({ quietHours: { end: e.target.value } })}
          className="rounded border border-gray-700 bg-gray-900 px-1.5 py-1 text-white"
        />
        <span className="text-gray-500">({prefs.timeZone})</span>
        {prefs.timeZone !== browserTimeZone() && (
          <button
            type="button"
            disabled={fieldsDisabled}
            onClick={() => save({ timeZone: browserTimeZone() })}
            className="text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
          >
            Use {browserTimeZone()}
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-500">Only urgent alerts come through in quiet hours.</p>

      <fieldset className="space-y-1">
        <legend className="text-xs text-gray-400">Watch</legend>
        {PROACTIVE_AREAS.map((area) => (
          <label key={area} className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={prefs.areas[area]}
              disabled={fieldsDisabled}
              onChange={(e) => save({ areas: { [area]: e.target.checked } })}
              data-testid={`server-agent-proactive-area-${area}`}
            />
            {PROACTIVE_AREA_LABELS[area]}
          </label>
        ))}
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input
          type="checkbox"
          checked={prefs.push}
          disabled={fieldsDisabled}
          onChange={(e) => save({ push: e.target.checked })}
          data-testid="server-agent-proactive-push"
        />
        Push new offers to my devices
      </label>

      {suppressions.length > 0 && (
        <div className="space-y-1" data-testid="server-agent-proactive-suppressions">
          <div className="text-xs text-gray-400">Never offer</div>
          {suppressions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded border border-gray-800 px-2 py-1 text-sm text-gray-300"
            >
              <span>{s.label}</span>
              <button
                type="button"
                onClick={() => void removeSuppression(s.id)}
                data-testid="server-agent-proactive-suppression-remove"
                className="text-xs text-gray-500 hover:text-white"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || checking}
          onClick={() => void checkNow()}
          data-testid="server-agent-proactive-check"
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
        {state?.lastCheckAt && (
          <span className="text-[11px] text-gray-500">
            Last check {new Date(state.lastCheckAt).toLocaleString()}:{' '}
            {state.lastError || CHECK_STATUS_COPY[state.lastStatus ?? ''] || state.lastStatus}
          </span>
        )}
        {status && (
          <span
            role="status"
            className={`text-xs ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Mail, Save } from 'lucide-react';
import { api } from '../utils/api';
import {
  routingDefaultLabel,
  summarizeRouting,
  type NotificationRouting,
} from '../utils/deployNotificationRouting';

/**
 * Per-environment notification-routing editor. Rendered inline under an
 * environment row in EnvironmentsManagementSection. Lets an operator pick which
 * release notification types fire when a deployment to this environment
 * succeeds, without touching deploy.yaml. The resolved read reflects the
 * env-name default (prod → reporter + digest, non-prod → nothing) until saved.
 */
export default function EnvironmentNotificationRoutingPanel({
  projectId,
  environmentName,
  showToast,
}: {
  projectId: string;
  environmentName: string;
  showToast?: (message: string, type?: string) => void;
}) {
  const [routing, setRouting] = useState<NotificationRouting | null>(null);
  const [ticketRelease, setTicketRelease] = useState(false);
  const [releaseDigest, setReleaseDigest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const notify = useCallback(
    (message: string, type: string = 'info') => showToast?.(message, type),
    [showToast],
  );

  const applyRouting = useCallback((next: NotificationRouting) => {
    setRouting(next);
    setTicketRelease(next.ticketReleaseEnabled);
    setReleaseDigest(next.releaseDigestEnabled);
  }, []);

  const load = useCallback(async () => {
    if (!projectId || !environmentName) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getNotificationRouting(projectId, environmentName);
      if (res?.routing) applyRouting(res.routing);
    } catch (e: any) {
      setError(e?.message || 'Failed to load notification routing');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentName, applyRouting]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    !!routing &&
    (ticketRelease !== routing.ticketReleaseEnabled ||
      releaseDigest !== routing.releaseDigestEnabled);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.updateNotificationRouting(projectId, environmentName, {
        ticketReleaseEnabled: ticketRelease,
        releaseDigestEnabled: releaseDigest,
      });
      if (res?.routing) applyRouting(res.routing);
      notify(`Notification routing saved for ${environmentName}`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to save notification routing', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-2 rounded-md border border-gray-800 bg-gray-900/60 p-3"
      data-testid={`env-notification-routing-${environmentName}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Mail size={13} className="text-violet-300" />
        <span className="text-xs font-semibold text-gray-200">Notification routing</span>
        {routing ? (
          <span className="inline-flex items-center rounded border border-gray-700 bg-gray-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
            {routingDefaultLabel(routing)}
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-gray-500">
        Which release emails fire when a deployment to{' '}
        <span className="font-mono">{environmentName}</span> succeeds. Production defaults to
        reporter + digest; other environments send nothing until you enable them here.
      </p>

      {error ? (
        <div className="mb-2 flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          <AlertCircle size={13} />
          {error}
        </div>
      ) : null}

      {loading && !routing ? (
        <div className="py-3 text-center text-xs text-gray-500">Loading routing...</div>
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-200">
            <input
              type="checkbox"
              checked={ticketRelease}
              onChange={(e) => setTicketRelease(e.target.checked)}
              aria-label="Send reporter (ticket release) emails"
              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-950"
            />
            Reporter emails
            <span className="text-[11px] text-gray-500">
              (notify support-ticket reporters their fix shipped)
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-200">
            <input
              type="checkbox"
              checked={releaseDigest}
              onChange={(e) => setReleaseDigest(e.target.checked)}
              aria-label="Send release digest emails"
              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-950"
            />
            Release digest
            <span className="text-[11px] text-gray-500">(notify digest subscribers)</span>
          </label>

          <div className="flex items-center gap-2 border-t border-gray-800 pt-3">
            <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">
              {summarizeRouting({
                ticketReleaseEnabled: ticketRelease,
                releaseDigestEnabled: releaseDigest,
              })}
            </span>
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

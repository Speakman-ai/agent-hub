import { useState } from 'react';
import { api } from '../utils/api.js';

/**
 * WebhookConfigBanner — drives the "missing webhook" nudge surfaced on
 * any project view whose `webhookConfigured === false`. Two outcomes
 * from the API call:
 *
 *   - **Full success** (`registration.ok === true`): we fire
 *     `onConfigured(result)` so the parent refetches projects;
 *     `webhookConfigured` flips to `true`; the banner naturally drops
 *     out of the tree.
 *
 *   - **Local row created but GitHub-side registration failed**
 *     (`registration.ok === false`): we deliberately do NOT fire
 *     `onConfigured`. If we did, the parent would refetch, see the new
 *     `enabled=1` row, flip `webhookConfigured` to `true`, and unmount
 *     the banner before the operator could read the warning. Keeping
 *     `onConfigured` un-fired means the banner stays mounted with the
 *     warning visible. We *also* call `showToast` (when provided) so
 *     even if some other path (WebSocket `projects_updated` broadcast,
 *     an unrelated refresh) unmounts the banner, the operator still
 *     sees the failure surfaced in the global toast tray. The original
 *     PR review caught a missed end-to-end case where the warning was
 *     painted and then immediately destroyed — this dual surfacing
 *     closes that gap.
 *
 * Props:
 *   - `projectId` — required. The slug used to call the API.
 *   - `onConfigured` — required. Fired only on full success so the
 *     parent can refetch projects and let the banner drop out.
 *   - `showToast` — optional. Global toast helper for failure
 *     surfacing. Signature: `showToast(message, opts?: { level })`.
 *     Same shape App.jsx hands to other components.
 *   - `compact` — optional. Renders a tighter layout for in-card use.
 *
 * Render policy: this component does **not** check `webhookConfigured`
 * itself. The caller is expected to gate on `project.webhookConfigured
 * === false` so the banner stays out of trees where it doesn't apply
 * (null = N/A, true = already configured).
 */
export default function WebhookConfigBanner({
  projectId,
  onConfigured,
  showToast,
  compact = false,
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  const handleConfigure = async () => {
    if (working) return;
    setError(null);
    setWarning(null);
    setWorking(true);
    try {
      const result = await api.autoConfigureProjectWebhook(projectId);
      const reg = result?.registration;
      if (reg && reg.ok === false) {
        // GitHub-side registration failed. Surface the raw error inline
        // AND via toast so the message survives even if the parent
        // refetches for some other reason. Do NOT call onConfigured —
        // see the docblock above for why an immediate refetch would
        // destroy the message before the operator could read it.
        const msg = `Webhook config saved locally but GitHub registration failed: ${
          reg.error || 'unknown error'
        }. The reviewer will not receive events until the webhook is registered manually on github.com (Settings → Developer settings → Webhooks).`;
        setWarning(msg);
        if (typeof showToast === 'function') {
          try {
            showToast(msg, { level: 'warning' });
          } catch {
            /* never let a toast surface throw stop the inline warning */
          }
        }
        return;
      }
      // Full success — let the parent refetch so the banner drops out.
      if (typeof onConfigured === 'function') onConfigured(result);
    } catch (err) {
      setError(err?.message || 'Unknown error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      data-testid="webhook-config-banner"
      role="alert"
      className={
        compact
          ? 'mb-3 rounded-md border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-sm text-amber-100'
          : 'mb-4 rounded-md border border-amber-700/50 bg-amber-900/25 px-4 py-3 text-sm text-amber-100'
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className={compact ? 'font-medium' : 'font-semibold'}>
            PR reviewer is not active for this project.
          </p>
          <p className="mt-1 text-amber-200/90">
            No GitHub webhook is configured, so pull-request events never reach Agent Hub and the
            reviewer agent will not be dispatched. Configure the webhook to enable automatic
            reviews.
          </p>
        </div>
        <button
          type="button"
          onClick={handleConfigure}
          disabled={working}
          aria-busy={working}
          data-testid="webhook-config-banner-action"
          className="shrink-0 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-amber-50 transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {working ? 'Configuring…' : 'Configure automatically'}
        </button>
      </div>
      {warning ? (
        <p
          data-testid="webhook-config-banner-warning"
          className="mt-2 rounded bg-amber-950/40 px-2 py-1 text-xs text-amber-200"
        >
          {warning}
        </p>
      ) : null}
      {error ? (
        <p
          data-testid="webhook-config-banner-error"
          className="mt-2 rounded bg-red-950/40 px-2 py-1 text-xs text-red-200"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

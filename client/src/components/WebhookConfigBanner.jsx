import { useState } from 'react';
import { api } from '../utils/api.js';

/**
 * WebhookConfigBanner — drives the "missing webhook" nudge surfaced on
 * any project view whose `webhookConfigured === false`. Two paths:
 *
 *   - **Configure automatically** → POST
 *     `/api/projects/:id/webhook/auto-configure`. On success the banner
 *     hides (the parent refetches and `webhookConfigured` flips to true).
 *     On a structured `registration.ok: false` response we keep the
 *     banner visible and render an inline error explaining that the
 *     local row exists but GitHub registration didn't take, with a
 *     pointer to the manual flow.
 *
 *   - **Configure manually** → tooltip/text link pointing at the GitHub
 *     Settings docs. Operators with installs that don't have a GitHub
 *     App configured AND no `gh auth login` on the host need this
 *     escape hatch.
 *
 * Props:
 *   - `projectId` — required. The slug used to call the API.
 *   - `onConfigured` — required. Fired after a successful auto-configure
 *     so the parent can refetch projects and let the banner drop out.
 *   - `compact` — optional. Renders a tighter layout for in-card use.
 *
 * Render policy: this component does **not** check `webhookConfigured`
 * itself. The caller is expected to gate on `project.webhookConfigured
 * === false` so the banner stays out of trees where it doesn't apply
 * (null = N/A, true = already configured).
 */
export default function WebhookConfigBanner({ projectId, onConfigured, compact = false }) {
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
        // Local row was created so the banner will drop on the next
        // refetch, but GitHub-side registration failed — surface the
        // raw error so the operator knows the webhook was NOT pushed
        // to github.com and needs the manual flow.
        setWarning(
          `Local webhook config was created but GitHub registration failed: ${
            reg.error || 'unknown error'
          }. The reviewer will not receive events until the webhook is registered manually in Settings → Developer settings → Webhooks on github.com.`,
        );
      }
      // Let the parent refetch (the parent is what reads
      // `webhookConfigured` — once the new row exists, the banner
      // naturally drops out of the tree).
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

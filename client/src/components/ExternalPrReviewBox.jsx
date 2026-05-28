import { useState } from 'react';
import { Eye, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../utils/api.js';

/**
 * "Review external PR" surface — pastes a GitHub PR URL and spawns a
 * reviewer-only session via `POST /api/projects/:projectId/external-pr-review`.
 *
 * Lives at the top of `PullRequestsPage` because that's where users
 * already think about pull requests; the existing per-row "Nudge"
 * button is for PRs already listed in the project's repo, this is
 * the "I have a URL in hand" workflow.
 *
 * Validates URL shape locally before posting; the server does the
 * authoritative repo / provenance / reviewer checks.
 *
 * Wired through §11 of `finalize-code-changes-architecture-v0`.
 */
export default function ExternalPrReviewBox({ projectId, reviewerAgentId, onToast }) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null); // { kind: 'success'|'error', text: string }

  const trimmed = url.trim();
  const looksLikePrUrl =
    trimmed.length > 0 &&
    /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(trimmed);

  const disabled = !reviewerAgentId || submitting || !looksLikePrUrl;
  const disabledReason = !reviewerAgentId
    ? 'No reviewer agent on this project'
    : !looksLikePrUrl
      ? 'Enter a GitHub PR URL (https://github.com/owner/repo/pull/N)'
      : submitting
        ? 'Dispatching…'
        : 'Spawn a reviewer-only session for this external PR';

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (disabled) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await api.reviewExternalPr(projectId, trimmed);
      const msg = res?.prNumber
        ? `PR #${res.prNumber}: reviewer dispatch queued — the reviewer session will appear in the sidebar shortly.`
        : 'Reviewer dispatch queued — the reviewer session will appear in the sidebar shortly.';
      setStatus({ kind: 'success', text: msg });
      setUrl('');
      if (typeof onToast === 'function') onToast(msg, 'success', 6000);
    } catch (err) {
      const raw = err?.message || 'Failed to dispatch reviewer';
      const cleaned = raw.replace(/^(\d{3}):\s*/, '');
      setStatus({ kind: 'error', text: cleaned });
      if (typeof onToast === 'function') {
        onToast(`Review external PR failed: ${cleaned}`, 'error', 7000);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Eye size={16} className="text-violet-300" aria-hidden />
        <h3 className="text-sm font-semibold text-white">Review external PR</h3>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        Paste a GitHub PR URL (contributor, dependabot, direct push) to spawn a reviewer-only
        session. The reviewer posts a single formal review back to GitHub and exits — no fix loop.
      </p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setStatus(null);
          }}
          placeholder="https://github.com/owner/repo/pull/123"
          className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-violet-500"
          aria-label="External PR URL"
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
        />
        <button
          type="submit"
          disabled={disabled}
          title={disabledReason}
          aria-label="Review external PR"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-800/80 bg-violet-950/40 text-sm font-medium text-violet-200 hover:bg-violet-950/70 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <Loader2 size={14} className="animate-spin text-violet-300" />
          ) : (
            <Eye size={14} className="text-violet-300" />
          )}
          Review
        </button>
      </form>
      {status && (
        <div
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`mt-2 flex items-start gap-2 text-xs ${
            status.kind === 'error' ? 'text-red-300' : 'text-emerald-300'
          }`}
        >
          {status.kind === 'error' ? (
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
          )}
          <span>{status.text}</span>
        </div>
      )}
    </div>
  );
}

import { ExternalLink, X } from 'lucide-react';
import { parseNativePrUrl } from '../utils/prFormatting';

/**
 * Shown instead of ChangesReadyBox when the session is fixing an existing PR
 * (`[Resolve PR #N]` title).
 *
 * `prUrl` is either a github.com URL or an Agent Hub-native route
 * (`/projects/<id>/pulls/<n>`). Native PRs open the in-app PR detail view —
 * sending the operator to github.com would land them on an unrelated PR
 * number in the mirror repo.
 */
export default function ResolveSessionPrBanner({
  prUrl,
  prNumber,
  branchLabel,
  sessionId,
  onDismiss,
  onOpenPrDetail,
}: any) {
  const nativeTarget = parseNativePrUrl(prUrl);
  const canOpenNative = Boolean(nativeTarget) && typeof onOpenPrDetail === 'function';
  const hostLabel = nativeTarget ? 'Agent Hub' : 'GitHub';

  return (
    <div className="flex justify-start mb-4 px-1">
      <div className="max-w-[95%] sm:max-w-[90%] w-full bg-gray-800/80 border border-gray-700/60 rounded-xl px-4 py-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <ExternalLink size={16} className="text-sky-400 shrink-0" />
              <span className="font-medium text-gray-200">
                Existing pull request{prNumber ? ` #${prNumber}` : ''}
              </span>
              {branchLabel ? (
                <span className="text-xs text-gray-500 truncate">({branchLabel})</span>
              ) : null}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {prUrl
                ? `Open the PR on ${hostLabel} — this session is not creating a new pull request.`
                : 'This session updates an existing pull request. Set the project’s repository in settings to enable an outbound link.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onDismiss?.(sessionId)}
            className="text-gray-500 hover:text-gray-300 p-0.5 shrink-0"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
        {canOpenNative ? (
          <button
            type="button"
            onClick={() => onOpenPrDetail(nativeTarget!.projectId, nativeTarget!.number)}
            className="inline-flex items-center gap-2 text-sm font-medium text-sky-400 hover:text-sky-300"
            data-testid="resolve-pr-banner-link"
          >
            Open PR on Agent Hub
            <ExternalLink size={14} />
          </button>
        ) : prUrl && !nativeTarget ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-sky-400 hover:text-sky-300"
            data-testid="resolve-pr-banner-link"
          >
            Open PR on GitHub
            <ExternalLink size={14} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

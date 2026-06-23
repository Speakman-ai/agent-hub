import { ExternalLink, X } from 'lucide-react';

/**
 * Shown instead of ChangesReadyBox when the session is fixing an existing PR
 * (`[Resolve PR #N]` title). Offers an outbound GitHub link when `prUrl` is known.
 */
export default function ResolveSessionPrBanner({
  prUrl,
  prNumber,
  branchLabel,
  sessionId,
  onDismiss,
}: any) {
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
                ? 'Open the PR on GitHub — this session is not creating a new pull request.'
                : 'This session updates an existing PR on GitHub. Set the project’s GitHub repository (owner/repo) to enable an outbound link.'}
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
        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-sky-400 hover:text-sky-300"
          >
            Open PR on GitHub
            <ExternalLink size={14} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

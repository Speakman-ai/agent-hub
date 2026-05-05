import { useState } from 'react';

/**
 * PreviewAttachment — renders the broadcast outcomes of an
 * `<agenthub:preview>` block (see `server/preview/preview-block.ts`).
 *
 * The component is fully driven by the broadcast event payload — it
 * doesn't talk to the API directly. Three render variants:
 *   - `kind === 'preview'` → live iframe + screenshot thumbnail.
 *   - `kind === 'preview_unavailable'` → teach moment with a deep-link
 *     to the project preview wizard.
 *   - `kind === 'preview_failed'` → log tail + retry button.
 *
 * `onRetry` and `onTouch` are optional handlers wired by the parent
 * chat view. `onRetry` re-issues the original chat message; `onTouch`
 * pings the runtime so the idle-TTL clock resets.
 */
export default function PreviewAttachment({ event, onRetry, onTouch }) {
  const [iframeOpen, setIframeOpen] = useState(false);

  if (!event || typeof event !== 'object') return null;

  const { kind } = event;
  if (kind === 'preview_unavailable') return <PreviewUnavailable event={event} />;
  if (kind === 'preview_failed') return <PreviewFailed event={event} onRetry={onRetry} />;

  // Default: a live preview event.
  const { previewUrl, fullUrl, port, route, target, screenshotPath, agentReason } = event;
  const renderUrl = fullUrl || previewUrl || '';

  return (
    <div className="my-3 rounded-lg border border-gray-700 bg-gray-900 p-3 text-sm text-gray-200">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-emerald-800/60 px-2 py-0.5 text-xs font-medium text-emerald-200">
          Preview ready
        </span>
        {route && (
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-xs text-gray-300">
            {route}
          </span>
        )}
        {typeof port === 'number' && (
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-xs text-gray-300">
            :{port}
          </span>
        )}
        {target && (
          <span className="rounded bg-gray-800 px-2 py-0.5 text-xs uppercase text-gray-400">
            {target}
          </span>
        )}
      </div>
      {agentReason && <div className="mb-2 text-xs italic text-gray-400">{agentReason}</div>}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
          onClick={() => setIframeOpen((v) => !v)}
        >
          {iframeOpen ? 'Hide iframe' : 'Open in iframe'}
        </button>
        <a
          href={renderUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-600"
        >
          Open in new tab
        </a>
        <button
          type="button"
          className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-600"
          onClick={() => onTouch?.(event)}
          disabled={!onTouch}
        >
          Refresh
        </button>
      </div>
      {iframeOpen && renderUrl && (
        <iframe
          src={renderUrl}
          title="Worktree preview"
          className="h-96 w-full rounded border border-gray-700 bg-white"
        />
      )}
      {screenshotPath && !iframeOpen && (
        <img
          src={screenshotPath}
          alt="Preview screenshot"
          className="max-h-64 w-full rounded border border-gray-700 object-contain object-top"
        />
      )}
    </div>
  );
}

function PreviewUnavailable({ event }) {
  const { wizardUrl, unavailableReason, agentReason } = event;
  const headline =
    unavailableReason === 'preview-disabled'
      ? 'Preview is disabled for this project'
      : 'Preview is not configured for this project';
  return (
    <div className="my-3 rounded-lg border border-amber-700/60 bg-amber-900/20 p-3 text-sm text-amber-100">
      <div className="mb-1 font-medium">{headline}</div>
      {agentReason && (
        <div className="mb-2 text-xs italic text-amber-200/70">
          The agent asked for: {agentReason}
        </div>
      )}
      <div className="mb-3 text-xs text-amber-200/70">
        Configure the preview runtime in project settings so future
        <code className="mx-1 rounded bg-amber-900/40 px-1 py-0.5 font-mono">
          &lt;agenthub:preview&gt;
        </code>
        requests can boot a live worktree preview here.
      </div>
      <div className="flex gap-2">
        {wizardUrl && (
          <a
            href={wizardUrl}
            className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
          >
            Configure preview
          </a>
        )}
        <button
          type="button"
          className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-600"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function PreviewFailed({ event, onRetry }) {
  const { error, logTail } = event;
  return (
    <div className="my-3 rounded-lg border border-red-700/60 bg-red-900/20 p-3 text-sm text-red-100">
      <div className="mb-2 font-medium">Preview failed to boot</div>
      {error && <div className="mb-2 font-mono text-xs text-red-200/80">{error}</div>}
      {Array.isArray(logTail) && logTail.length > 0 && (
        <pre className="mb-2 max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-xs text-red-200/90">
          {logTail.join('\n')}
        </pre>
      )}
      <button
        type="button"
        className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-600"
        onClick={() => onRetry?.(event)}
        disabled={!onRetry}
      >
        Retry
      </button>
    </div>
  );
}

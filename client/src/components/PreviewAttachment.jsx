import { useState } from 'react';

/**
 * PreviewAttachment — renders the broadcast outcomes of an
 * `<agenthub:preview>` block (see `server/preview/preview-block.ts`).
 *
 * The component is fully driven by the broadcast event payload — it
 * doesn't talk to the API directly. Three render variants:
 *   - `kind === 'preview'` → live iframe + screenshot thumbnail.
 *   - `kind === 'preview_unavailable'` → teach moment with a CTA that
 *     routes through `onConfigure(event)`. The event carries the
 *     preferred `wizard: { view, projectId }` navigation intent and a
 *     legacy `wizardUrl` string for one-release backwards compat. The
 *     web app uses `currentView` state instead of URL routing, so the
 *     parent typically maps `wizard.view` to `setCurrentView(...)` and
 *     `wizard.projectId` to its active-project setter.
 *   - `kind === 'preview_failed'` → log tail + retry button.
 *
 * `onRetry` and `onTouch` are optional handlers wired by the parent
 * chat view. `onRetry` re-issues the original chat message; `onTouch`
 * pings the runtime so the idle-TTL clock resets. `onConfigure(event)`
 * receives the full event so the parent can read `event.wizard` and
 * navigate. `onSkip(event)` is called when the user dismisses the
 * teach-moment card.
 */
export default function PreviewAttachment({ event, onRetry, onTouch, onConfigure, onSkip }) {
  const [iframeOpen, setIframeOpen] = useState(false);

  if (!event || typeof event !== 'object') return null;

  const { kind } = event;
  if (kind === 'preview_unavailable') {
    return <PreviewUnavailable event={event} onConfigure={onConfigure} onSkip={onSkip} />;
  }
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

function PreviewUnavailable({ event, onConfigure, onSkip }) {
  const { wizard, wizardUrl, unavailableReason, agentReason } = event;
  const [skipped, setSkipped] = useState(false);
  const headline =
    unavailableReason === 'preview-disabled'
      ? 'Preview is disabled for this project'
      : 'Live previews aren\u2019t set up for this project yet.';
  // Resolution order:
  //  1. `wizard` (preferred contract — a navigation intent the host app
  //     maps to `setCurrentView(view)` for the right project).
  //  2. `wizardUrl` (legacy string URL — kept for one release while
  //     in-flight broadcasts drain. The app doesn't use URL routing, so
  //     this href won't actually navigate, but it still renders as a
  //     link for visual consistency with older clients).
  const hasWizardIntent = !!(wizard && wizard.view);
  // Append `?focus=preview` to the legacy URL so older fallback wiring
  // can still scroll to the preview sub-section. Tolerates URLs that
  // already carry a query string.
  const legacyHref = wizardUrl
    ? wizardUrl.includes('focus=preview')
      ? wizardUrl
      : wizardUrl + (wizardUrl.includes('?') ? '&' : '?') + 'focus=preview'
    : null;
  if (skipped) return null;
  const handleConfigure = (e) => {
    // Always intercept the click when we can — the wizard intent (or
    // legacy URL) is meant to be resolved through `onConfigure`, not
    // the browser's default link follow.
    if (typeof onConfigure === 'function') {
      e.preventDefault();
      onConfigure(event);
    }
  };
  const handleSkip = () => {
    setSkipped(true);
    if (typeof onSkip === 'function') onSkip(event);
  };
  // CTA visibility: render whenever we have either form of intent OR an
  // `onConfigure` handler (the parent may know how to resolve the
  // event even without a payload-embedded link).
  const showCta = hasWizardIntent || !!legacyHref || typeof onConfigure === 'function';
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
        {showCta && (
          <a
            href={legacyHref || '#'}
            onClick={handleConfigure}
            className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
          >
            Configure preview
          </a>
        )}
        <button
          type="button"
          onClick={handleSkip}
          className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-600"
        >
          Skip — keep going
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

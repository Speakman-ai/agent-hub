/**
 * AWS Health events, on the Infrastructure Overview tab.
 *
 * This panel is the only infra surface that reports news the Hub did not go
 * looking for. Every other panel polls AWS and tells you what it measured;
 * AWS Health tells you what *AWS* knows and you cannot — a degraded EC2 control
 * plane in your Region, a scheduled RDS certificate rotation, an EBS volume of
 * yours flagged for retirement. None of that is visible in a CloudWatch metric
 * until it has already hurt, which is why it sits above the spend panels: this
 * is operational news, and the money below it can wait.
 *
 * Ingest-only, by design. The Hub never calls the AWS Health API (that would
 * need a Business/Enterprise support plan and credentials in the monitored
 * account). Instead the operator creates an EventBridge rule in their own
 * account that pushes matching events at the Hub's ingest route. The whole
 * setup affordance below exists because that rule is the operator's to create,
 * and the single most likely way to get it wrong is a `source` of
 * `"aws.health*"` — AWS event patterns do not wildcard, so such a rule matches
 * nothing, forever, silently. Handing over the exact literal removes the chance.
 *
 * Two distinct empty states, and the distinction is the point. "Ingest not
 * configured" and "configured but quiet" look identical on screen if you only
 * render one blank slate, and they call for opposite actions: go wire up a rule
 * versus go enjoy the calm. The server tells us which via `ingestConfigured`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, HeartPulse, Loader2 } from 'lucide-react';

import { isInfraAlertEventForProject } from '@shared/utils/infraAlerts';
import { api } from '../../utils/api.js';
import type {
  InfraHealthEventWire,
  InfraHealthEventsResponse,
  InfraHealthIngestResponse,
  InfraHealthSeverity,
} from '../../utils/api.js';
import { getServerBase } from '../../utils/connection';
import { copyToClipboard } from '../../utils/export';
import { relativeTime } from '../../utils/time';

/**
 * Poll interval, matching every other infra surface.
 *
 * The live WebSocket bridge below is what makes an outage appear immediately;
 * this poll is the floor under it. A socket that reconnects mid-incident drops
 * whatever broadcast landed while it was down, and "the timeline silently
 * missed the event you needed" is the one failure this panel cannot have.
 */
const POLL_MS = 60_000;

/** How many events the list asks for. Deep history belongs in AWS's console. */
const EVENT_LIMIT = 50;

/**
 * Descriptions past this length get an expand affordance.
 *
 * A length heuristic rather than a measured overflow: `line-clamp-2` clips in
 * CSS, and reading back whether it actually clipped costs a layout round-trip
 * per row. Erring toward offering the toggle is harmless; erring the other way
 * hides text with no way to reach it.
 */
const CLAMP_CHARS = 140;

const SEVERITY_DOT: Record<InfraHealthSeverity, string> = {
  critical: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
};

const SEVERITY_TEXT: Record<InfraHealthSeverity, string> = {
  critical: 'text-red-300',
  warning: 'text-amber-300',
  info: 'text-sky-300',
};

const SEVERITY_LABEL: Record<InfraHealthSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const STATUS_PILL: Record<string, string> = {
  open: 'border-red-900/60 bg-red-950/40 text-red-300',
  upcoming: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  closed: 'border-gray-700 bg-gray-900 text-gray-400',
};

/** Newest first, on the event's own clock, falling back to when we received it. */
function eventClock(event: InfraHealthEventWire): number {
  return event.startTime ?? event.receivedAt;
}

/**
 * Invoke an API call, converting a SYNCHRONOUS throw into a rejected promise.
 *
 * `api.*` looks async, but it resolves the server base and builds a URL before
 * it ever returns a promise, so it can throw outright. That throw is not a
 * rejection: raised inside an effect or a click handler it unwinds to the
 * nearest error boundary and takes the entire Overview tab down — scope editor
 * and spend panels included — over a panel neither of them depends on.
 *
 * Routing it into the existing `.catch()` instead means every call site gets
 * the same treatment: the error lands in the panel's own error slot, and any
 * `.finally()` still runs, which is what keeps a failed mint from stranding its
 * button disabled forever.
 */
function startRequest<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (err: unknown) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface InfraHealthTimelineProps {
  projectId: string;
  showToast?: (message: string, type?: string) => void;
}

export default function InfraHealthTimeline({
  projectId,
  showToast,
}: InfraHealthTimelineProps): React.ReactElement {
  const [data, setData] = useState<InfraHealthEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ingest-credential state. Kept separate from the event read because the
  // setup section is fetched lazily — an operator whose rule already works
  // should never pay a round-trip for a panel they will not open.
  const [ingest, setIngest] = useState<InfraHealthIngestResponse | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The plaintext credential, held only in this component's memory and only
   * until the operator navigates away. The server hashes it on mint and cannot
   * return it a second time, so this really is the one chance to copy it — the
   * banner beside it says so rather than letting the operator find out later.
   */
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  /**
   * Tri-state so the default can follow the data without fighting the operator.
   * `null` means "nobody has clicked": the section then opens itself exactly
   * when ingest is unconfigured, which is the only time it is the next action.
   * A click pins it either way.
   */
  const [setupOverride, setSetupOverride] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Project epoch. Bumped only when the operator switches projects, so a
  // one-shot request (the lazy ingest read, mint, revoke) that was in flight
  // across the switch cannot paint over the new project's panel.
  const generation = useRef(0);

  /**
   * Per-request sequence for the event read, which is the one request that
   * races against ITSELF.
   *
   * `load()` has four callers — the mount effect, the 60s poll, a WebSocket
   * broadcast, and the re-read after a mint — and nothing makes the network
   * return them in issue order. The project epoch cannot separate them: two
   * loads for the same project share a `generation`, so each would consider
   * the other current. A slow initial read landing after a fast
   * event-triggered one would then repaint the list *without* the outage that
   * triggered the refetch, and it would stay missing until the next 60s tick —
   * precisely when someone is watching for it.
   *
   * Incrementing per call makes "newest wins" total rather than per-project.
   * It also subsumes the epoch check here: switching projects runs the effect
   * below, which calls `load()` and so bumps this counter too.
   */
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    const fail = (err: unknown) => {
      // The events already on screen are deliberately kept: a transient blip
      // must not blank an outage the operator is in the middle of reading.
      setError(err instanceof Error ? err.message : 'Failed to load AWS Health events');
    };
    startRequest(() => api.getInfraHealthEvents(projectId, { limit: EVENT_LIMIT }))
      .then((body) => {
        // Superseded by a read issued after this one — drop it rather than let
        // an older list win by finishing last.
        if (loadSeq.current !== seq) return;
        setData(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (loadSeq.current !== seq) return;
        fail(err);
      });
  }, [projectId]);

  useEffect(() => {
    generation.current += 1;
    setData(null);
    setError(null);
    setIngest(null);
    setIngestError(null);
    setBusy(false);
    setSetupOverride(null);
    setExpanded({});
    // Cleared on every project switch without exception. A plaintext credential
    // for project A has no business rendering under project B's header, and it
    // cannot be re-fetched to correct itself.
    setMintedToken(null);
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    // The server broadcasts `infra_health_event` to every connected client and
    // App.tsx re-emits it as a window CustomEvent (the same bridge `wiki_update`
    // and `git_host_mirror` use), so this panel gets live updates without
    // holding the WS connection itself. Refetching rather than splicing the
    // broadcast in: the broadcast is a summary, and a re-read is both cheap and
    // the only thing that keeps `total` and `ingestConfigured` honest.
    const onHealthEvent = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as { projectId?: string | null } | null;
      if (!isInfraAlertEventForProject(detail, projectId)) return;
      load();
    };
    window.addEventListener('infra_health_event', onHealthEvent as EventListener);
    return () => window.removeEventListener('infra_health_event', onHealthEvent as EventListener);
  }, [load, projectId]);

  const setupOpen = setupOverride ?? (data ? !data.ingestConfigured : false);

  useEffect(() => {
    if (!setupOpen || ingest) return;
    const gen = generation.current;
    startRequest(() => api.getInfraHealthIngest(projectId))
      .then((body) => {
        if (generation.current !== gen) return;
        setIngest(body);
        setIngestError(null);
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        setIngestError(err instanceof Error ? err.message : 'Failed to load ingest settings');
      });
  }, [setupOpen, ingest, projectId]);

  const copy = (value: string, label: string) => {
    void copyToClipboard(value).then((ok) => {
      showToast?.(
        ok ? `${label} copied` : `${label} could not be copied`,
        ok ? 'success' : 'error',
      );
    });
  };

  const mint = () => {
    if (busy) return;
    const gen = generation.current;
    setBusy(true);
    startRequest(() => api.createInfraHealthIngestToken(projectId))
      .then((body) => {
        if (generation.current !== gen) return;
        setMintedToken(body.token);
        setIngest({
          token: body.info,
          ingestPath: body.ingestPath,
          eventPattern: body.eventPattern,
        });
        setIngestError(null);
        showToast?.('Ingest token created', 'success');
        // `ingestConfigured` just flipped; re-read so the empty state stops
        // claiming the rule was never wired up.
        load();
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        const message =
          err instanceof Error ? err.message : 'The ingest token could not be created';
        setIngestError(message);
        showToast?.(message, 'error');
      })
      .finally(() => {
        if (generation.current === gen) setBusy(false);
      });
  };

  const revoke = () => {
    if (busy) return;
    const gen = generation.current;
    setBusy(true);
    startRequest(() => api.revokeInfraHealthIngestToken(projectId))
      .then((body) => {
        if (generation.current !== gen) return;
        setMintedToken(null);
        setIngest((prev) => (prev ? { ...prev, token: body.token } : prev));
        setIngestError(null);
        showToast?.(body.revoked ? 'Ingest token revoked' : 'No ingest token to revoke', 'success');
        load();
      })
      .catch((err: unknown) => {
        if (generation.current !== gen) return;
        const message =
          err instanceof Error ? err.message : 'The ingest token could not be revoked';
        setIngestError(message);
        showToast?.(message, 'error');
      })
      .finally(() => {
        if (generation.current === gen) setBusy(false);
      });
  };

  const events = useMemo(
    () => (data ? [...data.events].sort((a, b) => eventClock(b) - eventClock(a)) : []),
    [data],
  );

  const header = (
    <header className="mb-3 flex items-center gap-2">
      <HeartPulse size={15} className="text-gray-400" />
      <h3 className="text-sm font-medium text-gray-200">AWS Health</h3>
      {!data && !error ? (
        <Loader2 size={13} className="animate-spin text-gray-500" aria-label="Loading" />
      ) : null}
      {data && data.total > events.length ? (
        <span className="ml-auto text-[11px] text-gray-500" data-testid="infra-health-total">
          {events.length} of {data.total}
        </span>
      ) : null}
    </header>
  );

  if (!data) {
    return (
      <section
        className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
        data-testid="infra-health-panel"
      >
        {header}
        {error ? (
          <p
            className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
            role="alert"
            data-testid="infra-health-error"
          >
            {error}
          </p>
        ) : (
          <p className="text-xs text-gray-500">Loading AWS Health events…</p>
        )}
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-gray-800 bg-gray-900/40 p-4"
      data-testid="infra-health-panel"
    >
      {header}

      {error ? (
        <p
          className="mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
          role="alert"
          data-testid="infra-health-error"
        >
          {error}
        </p>
      ) : null}

      {events.length === 0 ? (
        !data.ingestConfigured ? (
          <div
            className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs leading-5 text-gray-500"
            data-testid="infra-health-not-configured"
          >
            <p className="font-medium text-gray-400">AWS Health ingest not configured</p>
            <p className="mt-1">
              Nothing has been wired up to deliver AWS Health events to Agent Hub yet. Create an
              ingest token below, then add the EventBridge rule it describes in the AWS account you
              want covered.
            </p>
          </div>
        ) : (
          <p
            className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs leading-5 text-gray-500"
            data-testid="infra-health-empty"
          >
            No AWS Health events received yet. Ingest is configured, so this means AWS has not
            published anything affecting this account.
          </p>
        )
      ) : (
        <ol className="space-y-3" data-testid="infra-health-list">
          {events.map((event) => (
            <HealthRow
              key={event.id}
              event={event}
              expanded={Boolean(expanded[event.id])}
              onToggle={() => setExpanded((prev) => ({ ...prev, [event.id]: !prev[event.id] }))}
            />
          ))}
        </ol>
      )}

      <div className="mt-3 border-t border-gray-800 pt-3">
        <button
          type="button"
          onClick={() => setSetupOverride(!setupOpen)}
          aria-expanded={setupOpen}
          className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
          data-testid="infra-health-setup-toggle"
        >
          {setupOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Ingest setup
        </button>

        {setupOpen ? (
          <IngestSetup
            ingest={ingest}
            ingestError={ingestError}
            mintedToken={mintedToken}
            busy={busy}
            onMint={mint}
            onRevoke={revoke}
            onCopy={copy}
          />
        ) : null}
      </div>
    </section>
  );
}

function HealthRow({
  event,
  expanded,
  onToggle,
}: {
  event: InfraHealthEventWire;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const description = event.description ?? '';
  const clampable = description.length > CLAMP_CHARS;
  const status = event.statusCode;

  return (
    <li
      className="relative border-l border-gray-800 pl-4"
      data-testid="infra-health-event"
      data-severity={event.severity}
    >
      <span
        className={`absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full ${SEVERITY_DOT[event.severity]}`}
        data-testid="infra-health-severity-dot"
        aria-hidden="true"
      />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={`text-[11px] font-medium uppercase tracking-wide ${SEVERITY_TEXT[event.severity]}`}
          data-testid="infra-health-severity"
        >
          {SEVERITY_LABEL[event.severity]}
        </span>
        <span className="text-xs font-medium text-gray-200" data-testid="infra-health-service">
          {event.service || 'AWS'}
        </span>
        <span
          className="truncate font-mono text-[11px] text-gray-400"
          title={event.eventArn}
          data-testid="infra-health-type-code"
        >
          {event.eventTypeCode || event.detailType || 'AWS Health Event'}
        </span>
        {status ? (
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              STATUS_PILL[status] ?? STATUS_PILL.closed
            }`}
            data-testid="infra-health-status"
          >
            {status}
          </span>
        ) : null}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-500">
        {event.region ? <span data-testid="infra-health-region">{event.region}</span> : null}
        <span data-testid="infra-health-time">
          {relativeTime(event.startTime ?? event.receivedAt)}
        </span>
        {event.affectedEntityCount > 0 ? (
          <span className="text-gray-400" data-testid="infra-health-entities">
            {event.affectedEntityCount} affected{' '}
            {event.affectedEntityCount === 1 ? 'resource' : 'resources'}
          </span>
        ) : null}
        {event.backupEvent ? (
          // Not a duplicate and not a bug: AWS deliberately fans account-specific
          // events out to a backup Region as well as the event's own, so the same
          // incident legitimately arrives twice from two delivery Regions.
          <span
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-1 py-0.5 text-[10px] text-gray-400"
            data-testid="infra-health-backup"
            title="Delivered to this account's backup Region. AWS deliberately fans account-specific events out to a second Region, so the same event can arrive twice."
          >
            <AlertTriangle size={10} />
            backup Region
          </span>
        ) : null}
      </div>

      {description ? (
        <>
          <p
            className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-gray-400 ${
              expanded ? '' : 'line-clamp-2'
            }`}
            data-testid="infra-health-description"
          >
            {description}
          </p>
          {clampable ? (
            <button
              type="button"
              onClick={onToggle}
              className="mt-0.5 text-[11px] text-sky-400 hover:text-sky-300"
              data-testid="infra-health-expand"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function IngestSetup({
  ingest,
  ingestError,
  mintedToken,
  busy,
  onMint,
  onRevoke,
  onCopy,
}: {
  ingest: InfraHealthIngestResponse | null;
  ingestError: string | null;
  mintedToken: string | null;
  busy: boolean;
  onMint: () => void;
  onRevoke: () => void;
  onCopy: (value: string, label: string) => void;
}): React.ReactElement {
  const base = getServerBase() || (typeof window !== 'undefined' ? window.location.origin : '');
  const ingestUrl = ingest ? `${base}${ingest.ingestPath}` : '';
  const patternJson = ingest ? JSON.stringify(ingest.eventPattern, null, 2) : '';
  const live = Boolean(ingest?.token && !ingest.token.revokedAt);

  return (
    <div className="mt-2 space-y-3" data-testid="infra-health-setup">
      {ingestError ? (
        <p
          className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300"
          role="alert"
          data-testid="infra-health-setup-error"
        >
          {ingestError}
        </p>
      ) : null}

      <p className="text-[11px] leading-5 text-gray-500" data-testid="infra-health-setup-note">
        Agent Hub cannot create this rule for you — it lives in your AWS account. Add an EventBridge
        rule on the default bus whose <span className="font-mono">source</span> is exactly{' '}
        <span className="font-mono text-gray-400">aws.health</span> (a wildcard such as{' '}
        <span className="font-mono">aws.health*</span> never matches) and point it at the URL below
        via an API destination. Send the token as{' '}
        <span className="font-mono">Authorization: Bearer …</span>, or as{' '}
        <span className="font-mono">x-agenthub-health-token</span> if a proxy in front of the
        endpoint eats the standard header.
      </p>

      {ingest ? (
        <>
          <LabelledCopy
            label="Ingest URL"
            value={ingestUrl}
            testId="infra-health-ingest-url"
            onCopy={onCopy}
          />

          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[11px] font-medium text-gray-400">Event pattern</span>
              <button
                type="button"
                onClick={() => onCopy(patternJson, 'Event pattern')}
                className="inline-flex items-center gap-1 rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 text-[10px] text-gray-300 hover:border-gray-600"
                data-testid="infra-health-copy-pattern"
              >
                <Copy size={10} />
                Copy
              </button>
            </div>
            <pre
              className="overflow-x-auto rounded-lg border border-gray-800 bg-gray-950/60 p-2 font-mono text-[11px] leading-5 text-gray-300"
              data-testid="infra-health-event-pattern"
            >
              {patternJson}
            </pre>
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-500">Loading ingest settings…</p>
      )}

      {mintedToken ? (
        <div
          className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-2.5"
          data-testid="infra-health-token-reveal"
        >
          <p
            className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300"
            data-testid="infra-health-token-warning"
          >
            <AlertTriangle size={11} />
            Copy this now — it is shown only once and can never be read back.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded border border-gray-800 bg-gray-950/70 px-2 py-1 font-mono text-[11px] text-gray-200"
              data-testid="infra-health-token-plaintext"
            >
              {mintedToken}
            </code>
            <button
              type="button"
              onClick={() => onCopy(mintedToken, 'Ingest token')}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-gray-700 bg-gray-900 px-1.5 py-1 text-[10px] text-gray-300 hover:border-gray-600"
              data-testid="infra-health-copy-token"
            >
              <Copy size={10} />
              Copy
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-amber-200/70">
            Lost it? There is no recovery path — mint a new one and update the EventBridge target.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onMint}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          data-testid="infra-health-mint"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {live ? 'Rotate ingest token' : 'Create ingest token'}
        </button>
        {live ? (
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs text-gray-300 hover:border-gray-600 disabled:opacity-40"
            data-testid="infra-health-revoke"
          >
            Revoke
          </button>
        ) : null}
        {ingest?.token ? (
          <span className="text-[11px] text-gray-500" data-testid="infra-health-token-info">
            <span className="font-mono">{ingest.token.tokenPrefix}…</span>
            {ingest.token.revokedAt
              ? ' · revoked'
              : ingest.token.lastUsedAt
                ? ` · last used ${relativeTime(ingest.token.lastUsedAt)}`
                : ' · never used'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LabelledCopy({
  label,
  value,
  testId,
  onCopy,
}: {
  label: string;
  value: string;
  testId: string;
  onCopy: (value: string, label: string) => void;
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-gray-400">{label}</div>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 overflow-x-auto rounded border border-gray-800 bg-gray-950/60 px-2 py-1 font-mono text-[11px] text-gray-300"
          data-testid={testId}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => onCopy(value, label)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-gray-700 bg-gray-900 px-1.5 py-1 text-[10px] text-gray-300 hover:border-gray-600"
          data-testid={`${testId}-copy`}
        >
          <Copy size={10} />
          Copy
        </button>
      </div>
    </div>
  );
}

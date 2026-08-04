/**
 * rrweb capture → readable transcript.
 *
 * A stored replay is 250–400 KB of serialized DOM node soup: a `FullSnapshot`
 * followed by thousands of incremental mutations, keyed by opaque numeric node
 * ids. It is built for a *player*, not a reader — which is why the previous
 * "give the model some replay context" attempt (a 4 KB raw-JSON prefix spliced
 * into the triage prompt) delivered zero interactions and zero errors: 4 KB of
 * a FullSnapshot is the `<head>` of the document.
 *
 * This module turns that event stream into the thing a human or an agent
 * actually needs — a timeline:
 *
 *     +00:00.0  page      https://app.example.com/checkout (1440×900)
 *     +00:03.2  click     button#submit.primary "Place order"
 *     +00:03.4  network   POST https://api.example.com/orders → 500 (241ms)
 *     +00:03.4  error     TypeError: Cannot read properties of undefined
 *     +00:05.1  click ×4  button#submit.primary "Place order" (rapid repeat)
 *
 * How it works: the `FullSnapshot` seeds a node mirror (id → tag/attrs/text),
 * mutations keep it current, and every interaction is rendered against it so a
 * click on node `147` reads as `button#submit.primary "Place order"`. High-noise
 * sources (mouse moves, style/canvas/font mutations) are dropped and counted;
 * mutation bursts and repeated clicks are coalesced.
 *
 * Pure and IO-free — events in, transcript out, same input always yields the
 * same output. All replay-derived text is redacted through the shared log
 * secret pipeline before it is rendered; prompt-fencing is the caller's job
 * (see replay-context-pack.ts).
 */
import { buildRedactionConfig, redactText, type RedactionConfig } from '../logs/log-redaction.js';

// ─── rrweb constants (inlined; the server has no rrweb dependency) ─

/** rrweb `EventType`. */
export const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
} as const;

/** rrweb `IncrementalSource`. */
export const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
  MediaInteraction: 7,
  StyleSheetRule: 8,
  CanvasMutation: 9,
  Font: 10,
  Log: 11,
  Drag: 12,
  StyleDeclaration: 13,
  Selection: 14,
  AdoptedStyleSheet: 15,
  CustomElement: 16,
} as const;

/** rrweb `MouseInteractions` → the verb rendered in the transcript. Entries that
 *  map to `null` are dropped (mouse up/down are already implied by `click`). */
const MOUSE_INTERACTION_VERBS: Record<number, string | null> = {
  0: null, // MouseUp
  1: null, // MouseDown
  2: 'click',
  3: 'right-click',
  4: 'double-click',
  5: 'focus',
  6: 'blur',
  7: 'touch',
  8: null, // TouchMove_Departed
  9: 'touch-end',
  10: null, // TouchCancel
};

/** rrweb `MediaInteractions`. */
const MEDIA_VERBS: Record<number, string> = {
  0: 'media play',
  1: 'media pause',
  2: 'media seek',
  3: 'media volume',
  4: 'media rate',
};

/** rrweb serialized `NodeType`. */
const NodeType = { Document: 0, DocumentType: 1, Element: 2, Text: 3, CDATA: 4, Comment: 5 };

/** Custom-event tags emitted by the client instrumentation (must stay in sync
 *  with client/src/utils/replayInstrumentation.ts). */
export const REPLAY_CONSOLE_TAG = 'agent-hub/console';
export const REPLAY_NETWORK_TAG = 'agent-hub/network';

// ─── Tunables ─────────────────────────────────────────────────────

/** Max transcript lines before head/tail elision kicks in. */
export const DEFAULT_MAX_LINES = 400;
/** Max UTF-8 bytes of rendered transcript. */
export const DEFAULT_MAX_BYTES = 24 * 1024;
/** Consecutive clicks on the same node within this window collapse into one
 *  `×N (rapid repeat)` line — the transcript's rage-click signal. */
export const RAGE_CLICK_WINDOW_MS = 1500;
/** Scrolls on the same node within this window collapse into one line. */
export const SCROLL_COALESCE_MS = 1000;
/** Max chars of an element's text label. */
const MAX_LABEL_CHARS = 60;
/** Max chars of a rendered node description. */
const MAX_NODE_DESC_CHARS = 120;
/** Max chars for any single transcript field (console message, url, value). */
const MAX_FIELD_CHARS = 300;
/** Depth searched under an element for its text label. */
const MAX_LABEL_DEPTH = 3;
/** Attributes worth rendering, in priority order. */
const LABEL_ATTRIBUTES = [
  'data-testid',
  'aria-label',
  'name',
  'placeholder',
  'title',
  'alt',
  'type',
  'role',
  'href',
];

// ─── Types ────────────────────────────────────────────────────────

/** Loosely-typed rrweb event (the store persists them opaquely). */
export interface RrwebEventLike {
  type: number;
  timestamp?: number;
  data?: any;
}

export interface ReplayTranscriptOptions {
  /** Line budget before elision. Defaults to {@link DEFAULT_MAX_LINES}. */
  maxLines?: number;
  /** Byte budget for the rendered text. Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Redaction config; defaults to the built-in secret patterns. */
  redaction?: RedactionConfig;
}

export interface ReplayTranscriptStats {
  /** Events read from the capture. */
  eventCount: number;
  /** Timeline lines produced (before elision). */
  lineCount: number;
  /** Clicks / taps / key entries recorded. */
  interactionCount: number;
  /** Console errors + uncaught exceptions + unhandled rejections. */
  errorCount: number;
  /** Network entries with status >= 400 or a transport error. */
  networkFailureCount: number;
  /** Rapid-repeat (rage) click bursts detected. */
  rageClickCount: number;
  /** Events deliberately not rendered (mouse moves, style/canvas noise, …). */
  droppedEventCount: number;
  /** Capture span in ms (last timestamp − first timestamp). */
  durationMs: number;
  /** Whether the line/byte budget forced elision. */
  truncated: boolean;
  /** Distinct page URLs visited, in order. */
  pageUrls: string[];
  /** True when the capture carries console/network custom events. Old captures
   *  (recorded before client instrumentation shipped) have none, which is worth
   *  telling the reader so an empty error list isn't read as "no errors". */
  hasTelemetry: boolean;
}

export interface ReplayTranscript {
  /** Rendered timeline, one event per line. */
  text: string;
  /** The individual rendered lines (pre-join), for tests / alternate renderers. */
  lines: string[];
  stats: ReplayTranscriptStats;
  /** Secrets masked while rendering. */
  redactions: number;
}

// ─── Node mirror ──────────────────────────────────────────────────

interface MirrorNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  parentId?: number;
  childIds: number[];
}

/**
 * The id → node map rrweb's player rebuilds internally, reduced to what a
 * transcript needs (tag, a few attributes, text). Without it every interaction
 * line would read `node 147`, which tells a reader nothing.
 */
export class ReplayNodeMirror {
  private nodes = new Map<number, MirrorNode>();

  /** Seed from a `FullSnapshot`'s serialized document tree. */
  ingestSnapshot(root: any): void {
    this.nodes.clear();
    this.addNode(root, undefined);
  }

  /** Apply one incremental mutation so later interactions resolve correctly. */
  applyMutation(data: any): void {
    if (!data) return;
    for (const add of asArray(data.adds)) {
      if (add?.node)
        this.addNode(add.node, typeof add.parentId === 'number' ? add.parentId : undefined);
    }
    for (const rm of asArray(data.removes)) {
      if (typeof rm?.id === 'number') this.removeNode(rm.id);
    }
    for (const t of asArray(data.texts)) {
      const node = this.nodes.get(t?.id);
      if (node) node.textContent = typeof t.value === 'string' ? t.value : node.textContent;
    }
    for (const a of asArray(data.attributes)) {
      const node = this.nodes.get(a?.id);
      if (node && a.attributes && typeof a.attributes === 'object') {
        node.attributes = { ...(node.attributes ?? {}), ...a.attributes };
      }
    }
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  get size(): number {
    return this.nodes.size;
  }

  /**
   * Render a node as a compact CSS-ish selector plus its visible label:
   * `button#submit.primary "Place order"`. Text nodes resolve to their parent
   * element (clicking a label's text is a click on the label). Unknown ids fall
   * back to `node #<id>` so a mutation we never saw doesn't lose the event.
   */
  describe(id: number): string {
    const node = this.nodes.get(id);
    if (!node) return `node #${id}`;
    if (node.type === NodeType.Text) {
      const parent = node.parentId != null ? this.nodes.get(node.parentId) : undefined;
      if (parent) return this.describe(parent.id);
      const text = collapse(node.textContent ?? '');
      return text ? `text "${clip(text, MAX_LABEL_CHARS)}"` : `node #${id}`;
    }
    if (node.type !== NodeType.Element) return `node #${id}`;

    const tag = (node.tagName || 'node').toLowerCase();
    const attrs = node.attributes ?? {};
    let selector = tag;
    const elemId = stringAttr(attrs.id);
    if (elemId) selector += `#${elemId}`;
    const className = stringAttr(attrs.class);
    if (className) {
      const classes = className.split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length) selector += `.${classes.join('.')}`;
    }

    const parts = [selector];
    const label = this.textLabel(node, 0);
    if (label) {
      parts.push(`"${clip(label, MAX_LABEL_CHARS)}"`);
    } else {
      // No visible text (icon buttons, inputs) — fall back to the most
      // identifying attribute so the line still names something a dev can grep.
      for (const key of LABEL_ATTRIBUTES) {
        const value = stringAttr(attrs[key]);
        if (value) {
          parts.push(`[${key}=${clip(value, MAX_LABEL_CHARS)}]`);
          break;
        }
      }
    }
    return clip(parts.join(' '), MAX_NODE_DESC_CHARS);
  }

  /** Concatenated descendant text, bounded by depth and length. */
  private textLabel(node: MirrorNode, depth: number): string {
    if (depth > MAX_LABEL_DEPTH) return '';
    let out = '';
    for (const childId of node.childIds) {
      const child = this.nodes.get(childId);
      if (!child) continue;
      if (child.type === NodeType.Text) out += ` ${child.textContent ?? ''}`;
      else if (child.type === NodeType.Element) out += ` ${this.textLabel(child, depth + 1)}`;
      if (out.length > MAX_LABEL_CHARS * 2) break;
    }
    return collapse(out);
  }

  private addNode(serialized: any, parentId: number | undefined): void {
    if (!serialized || typeof serialized.id !== 'number') return;
    const node: MirrorNode = {
      id: serialized.id,
      type: typeof serialized.type === 'number' ? serialized.type : NodeType.Element,
      childIds: [],
    };
    if (typeof serialized.tagName === 'string') node.tagName = serialized.tagName;
    if (serialized.attributes && typeof serialized.attributes === 'object') {
      node.attributes = serialized.attributes;
    }
    if (typeof serialized.textContent === 'string') node.textContent = serialized.textContent;
    if (parentId != null) {
      node.parentId = parentId;
      const parent = this.nodes.get(parentId);
      if (parent && !parent.childIds.includes(node.id)) parent.childIds.push(node.id);
    }
    this.nodes.set(node.id, node);
    for (const child of asArray(serialized.childNodes)) this.addNode(child, node.id);
  }

  private removeNode(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // Depth-first so a removed subtree doesn't leave orphans behind that could
    // later shadow a recycled id.
    for (const childId of [...node.childIds]) this.removeNode(childId);
    if (node.parentId != null) {
      const parent = this.nodes.get(node.parentId);
      if (parent) parent.childIds = parent.childIds.filter((c) => c !== id);
    }
    this.nodes.delete(id);
  }
}

// ─── Transcript ───────────────────────────────────────────────────

interface PendingLine {
  at: number;
  kind: string;
  detail: string;
  /** Coalescing key: same key + close in time merges into a `×N` line. */
  mergeKey?: string;
  count: number;
  suffix?: string;
}

/**
 * Build the transcript for a capture. Deterministic and side-effect free.
 */
export function buildReplayTranscript(
  events: readonly RrwebEventLike[],
  opts: ReplayTranscriptOptions = {},
): ReplayTranscript {
  const redaction = opts.redaction ?? buildRedactionConfig();
  const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(256, opts.maxBytes ?? DEFAULT_MAX_BYTES);

  const mirror = new ReplayNodeMirror();
  const pending: PendingLine[] = [];
  const pageUrls: string[] = [];
  let redactions = 0;
  let interactionCount = 0;
  let errorCount = 0;
  let networkFailureCount = 0;
  let rageClickCount = 0;
  let droppedEventCount = 0;
  let hasTelemetry = false;
  let firstTs: number | null = null;
  let lastTs = 0;

  // Mutation coalescing accumulator: a burst of DOM mutations renders as ONE
  // line ("dom: +12 nodes, -3 nodes"), because 400 individual mutation lines
  // would bury the four lines that matter.
  let mutationBurst: { at: number; adds: number; removes: number; updates: number } | null = null;

  const flushMutationBurst = () => {
    if (!mutationBurst) return;
    const { at, adds, removes, updates } = mutationBurst;
    mutationBurst = null;
    const parts: string[] = [];
    if (adds) parts.push(`+${adds} node${adds === 1 ? '' : 's'}`);
    if (removes) parts.push(`-${removes} node${removes === 1 ? '' : 's'}`);
    if (updates) parts.push(`${updates} update${updates === 1 ? '' : 's'}`);
    if (!parts.length) return;
    push({ at, kind: 'dom', detail: parts.join(', '), count: 1 });
  };

  function push(line: PendingLine): void {
    const prev = pending[pending.length - 1];
    if (
      prev &&
      line.mergeKey &&
      prev.mergeKey === line.mergeKey &&
      line.at - prev.at <= mergeWindowFor(line.kind)
    ) {
      prev.count += 1;
      // `prev.at` intentionally keeps the FIRST timestamp of the burst: that's
      // when the user started hammering, which is what a reader wants to see.
      if (prev.kind === 'click' && prev.count === 3) rageClickCount += 1;
      return;
    }
    pending.push(line);
  }

  const redact = (value: string): string => {
    const r = redactText(value, redaction);
    redactions += r.redactions;
    return clip(collapse(r.value), MAX_FIELD_CHARS);
  };

  for (const event of events ?? []) {
    if (!event || typeof event.type !== 'number') {
      droppedEventCount += 1;
      continue;
    }
    const ts: number = typeof event.timestamp === 'number' ? event.timestamp : (firstTs ?? 0);
    if (firstTs === null) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    const at = Math.max(0, ts - (firstTs ?? ts));

    switch (event.type) {
      case EventType.Meta: {
        flushMutationBurst();
        const href = redact(String(event.data?.href ?? ''));
        const width = numberOr(event.data?.width, 0);
        const height = numberOr(event.data?.height, 0);
        if (href && !pageUrls.includes(href)) pageUrls.push(href);
        push({
          at,
          kind: 'page',
          detail: `${href || '(unknown url)'}${width && height ? ` (${width}×${height})` : ''}`,
          count: 1,
        });
        break;
      }

      case EventType.FullSnapshot: {
        flushMutationBurst();
        mirror.ingestSnapshot(event.data?.node);
        push({
          at,
          kind: 'snapshot',
          detail: `page state captured (${mirror.size} nodes)`,
          count: 1,
        });
        break;
      }

      case EventType.Custom: {
        flushMutationBurst();
        const tag = String(event.data?.tag ?? '');
        const payload = event.data?.payload;
        if (tag === REPLAY_CONSOLE_TAG) {
          hasTelemetry = true;
          const level = String(payload?.level ?? 'log');
          const isError =
            level === 'error' || level === 'exception' || level === 'unhandledrejection';
          if (isError) errorCount += 1;
          const message = redact(String(payload?.message ?? ''));
          const stack = payload?.stack ? redact(String(payload.stack)) : '';
          push({
            at,
            kind: isError ? 'error' : level === 'warn' ? 'warn' : 'console',
            detail: stack ? `${message} — ${stack}` : message,
            mergeKey: `console:${level}:${message}`,
            count: 1,
          });
        } else if (tag === REPLAY_NETWORK_TAG) {
          hasTelemetry = true;
          const status = numberOr(payload?.status, 0);
          const error = payload?.error ? redact(String(payload.error)) : '';
          if (status >= 400 || status === 0) networkFailureCount += 1;
          const method = String(payload?.method ?? 'GET')
            .toUpperCase()
            .slice(0, 10);
          const url = redact(String(payload?.url ?? ''));
          const duration = numberOr(payload?.durationMs, 0);
          const outcome = status ? `→ ${status}` : `→ failed${error ? ` (${error})` : ''}`;
          push({
            at,
            kind: status >= 400 || status === 0 ? 'network!' : 'network',
            detail: `${method} ${url} ${outcome} (${Math.round(duration)}ms)`,
            count: 1,
          });
        } else {
          droppedEventCount += 1;
        }
        break;
      }

      case EventType.IncrementalSnapshot: {
        const source = numberOr(event.data?.source, -1);
        switch (source) {
          case IncrementalSource.Mutation: {
            mirror.applyMutation(event.data);
            const adds = asArray(event.data?.adds).length;
            const removes = asArray(event.data?.removes).length;
            const updates =
              asArray(event.data?.texts).length + asArray(event.data?.attributes).length;
            if (!mutationBurst) mutationBurst = { at, adds: 0, removes: 0, updates: 0 };
            mutationBurst.adds += adds;
            mutationBurst.removes += removes;
            mutationBurst.updates += updates;
            break;
          }
          case IncrementalSource.MouseInteraction: {
            const verb = MOUSE_INTERACTION_VERBS[numberOr(event.data?.type, -1)] ?? null;
            if (!verb) {
              droppedEventCount += 1;
              break;
            }
            flushMutationBurst();
            const target = mirror.describe(numberOr(event.data?.id, -1));
            if (verb === 'click' || verb === 'double-click' || verb === 'touch') {
              interactionCount += 1;
            }
            push({
              at,
              kind: verb,
              detail: target,
              mergeKey: `${verb}:${target}`,
              count: 1,
            });
            break;
          }
          case IncrementalSource.Input: {
            flushMutationBurst();
            interactionCount += 1;
            const target = mirror.describe(numberOr(event.data?.id, -1));
            const raw = event.data?.text;
            // rrweb already masks inputs per the recorder's privacy options;
            // re-redact and summarize anyway — a value that reached us in the
            // clear (an unmasked field) must not be rendered verbatim.
            const value =
              typeof event.data?.isChecked === 'boolean' && raw == null
                ? event.data.isChecked
                  ? 'checked'
                  : 'unchecked'
                : summarizeInputValue(String(raw ?? ''), redact);
            push({
              at,
              kind: 'input',
              detail: `${target} ${value}`,
              mergeKey: `input:${target}`,
              count: 1,
            });
            break;
          }
          case IncrementalSource.Scroll: {
            flushMutationBurst();
            const target = mirror.describe(numberOr(event.data?.id, -1));
            push({
              at,
              kind: 'scroll',
              detail: `${target} → x=${Math.round(numberOr(event.data?.x, 0))} y=${Math.round(
                numberOr(event.data?.y, 0),
              )}`,
              mergeKey: `scroll:${target}`,
              count: 1,
            });
            break;
          }
          case IncrementalSource.ViewportResize: {
            flushMutationBurst();
            push({
              at,
              kind: 'viewport',
              detail: `${numberOr(event.data?.width, 0)}×${numberOr(event.data?.height, 0)}`,
              mergeKey: 'viewport',
              count: 1,
            });
            break;
          }
          case IncrementalSource.MediaInteraction: {
            flushMutationBurst();
            const verb = MEDIA_VERBS[numberOr(event.data?.type, -1)];
            if (!verb) {
              droppedEventCount += 1;
              break;
            }
            push({
              at,
              kind: verb,
              detail: mirror.describe(numberOr(event.data?.id, -1)),
              count: 1,
            });
            break;
          }
          default:
            // MouseMove / TouchMove / style / canvas / font / selection: pure
            // noise for a written timeline. Counted, never rendered.
            droppedEventCount += 1;
            break;
        }
        break;
      }

      default:
        // DomContentLoaded / Load / Plugin — no reader value on their own.
        droppedEventCount += 1;
        break;
    }
  }
  flushMutationBurst();

  const rendered = pending.map(renderLine);
  const { lines, truncated } = applyBudget(rendered, maxLines, maxBytes);

  return {
    text: lines.join('\n'),
    lines,
    stats: {
      eventCount: events?.length ?? 0,
      lineCount: pending.length,
      interactionCount,
      errorCount,
      networkFailureCount,
      rageClickCount,
      droppedEventCount,
      durationMs: firstTs === null ? 0 : Math.max(0, lastTs - firstTs),
      truncated,
      pageUrls,
      hasTelemetry,
    },
    redactions,
  };
}

/** Coalescing window per line kind. */
function mergeWindowFor(kind: string): number {
  if (kind === 'scroll') return SCROLL_COALESCE_MS;
  if (kind === 'viewport' || kind === 'input') return SCROLL_COALESCE_MS;
  return RAGE_CLICK_WINDOW_MS;
}

function renderLine(line: PendingLine): string {
  const count = line.count > 1 ? ` ×${line.count}` : '';
  const repeat = line.count >= 3 && line.kind === 'click' ? ' (rapid repeat)' : '';
  const label = `${line.kind}${count}`.padEnd(14);
  return `${formatOffset(line.at)}  ${label} ${line.detail}${repeat}`.trimEnd();
}

/** `+MM:SS.s` relative to the first event. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `+${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

/**
 * Enforce the line and byte budgets by eliding the MIDDLE of the timeline.
 * The head carries the setup (what page, what the user was doing) and the tail
 * carries the failure — dropping either end would remove exactly the context a
 * reader needs, so the sag goes in the middle with an explicit marker.
 */
function applyBudget(
  lines: string[],
  maxLines: number,
  maxBytes: number,
): { lines: string[]; truncated: boolean } {
  if (lines.length <= maxLines && byteLen(lines.join('\n')) <= maxBytes) {
    return { lines, truncated: false };
  }

  // Shrink the kept-line count monotonically until the rendering fits the byte
  // budget. `keep` strictly decreases every iteration, so this always
  // terminates — an earlier version spliced lines in and out of the middle and
  // could oscillate forever on a marker it kept re-adding.
  let keep = Math.min(lines.length, maxLines);
  let out = elideMiddle(lines, keep);
  while (byteLen(out.join('\n')) > maxBytes && keep > 2) {
    keep = Math.max(2, keep - Math.max(1, Math.ceil(keep * 0.1)));
    out = elideMiddle(lines, keep);
  }

  // Pathological case: two lines alone still blow the budget (a single enormous
  // detail string). Hard-cut the rendered text so the contract holds.
  let text = out.join('\n');
  if (byteLen(text) > maxBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');
    out = text.split('\n');
  }

  return { lines: out, truncated: true };
}

/** Keep the head and tail of a timeline, replacing the middle with a marker. */
function elideMiddle(lines: string[], keep: number): string[] {
  if (lines.length <= keep) return [...lines];
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return [
    ...lines.slice(0, head),
    `… ${lines.length - head - tail} lines elided …`,
    ...lines.slice(lines.length - tail),
  ];
}

/**
 * Render a typed value without leaking it. rrweb masks inputs at record time
 * (`***`), but the recorder's masking mode is configurable, so an unmasked
 * value can legitimately arrive here — and a customer's typed text is exactly
 * what must not land verbatim in an agent's context. Masked placeholders and
 * short opaque tokens render as-is; anything else becomes a shape description.
 */
export function summarizeInputValue(raw: string, redact: (v: string) => string): string {
  const value = raw ?? '';
  if (!value) return '(cleared)';
  if (/^[*•·•]+$/.test(value)) return `(masked, ${value.length} chars)`;
  const redacted = redact(value);
  if (redacted !== value) return `"${redacted}"`;
  if (value.length <= 24) return `"${clip(value, 24)}"`;
  return `(${value.length} chars) "${clip(value, 24)}"`;
}

// ─── Small helpers ────────────────────────────────────────────────

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringAttr(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

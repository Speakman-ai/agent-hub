/**
 * Demo recording for the Agent browser pane.
 *
 * A human presses Record in the pane, does the task once in the agent's
 * Chromium, and presses Stop. Captured steps:
 *   - URL changes (URL bar navigations and page-driven navigations)
 *   - clicks, with a CSS selector and the target's visible text
 *   - typed text, coalesced per field; password / one-time-code / card fields
 *     and unreadable targets are stored masked
 *   - named keys and chords (Enter, Tab, Escape, Ctrl+A, …)
 *   - scrolls, coalesced
 *
 * Two rules keep a recording faithful to what actually happened:
 *
 * 1. One ordered queue per chat session. Every human operation from the pane
 *    (viewer input and URL-bar navigation) goes through {@link record} /
 *    {@link recordNavigation}, which run them one at a time in arrival order
 *    and bind each to the recording that was active when it was accepted.
 *    The queue keeps ordering after Stop until it drains, Stop waits for the
 *    work it accepted, and the caller's dispatch re-resolves the page and
 *    re-checks the agent lock when it actually runs.
 *
 * 2. URL changes are credited at observation points, not guessed from timing.
 *    The recorder observes the URL before and after each human operation, on
 *    every agent op start/end ({@link observeAgentActivity}), on a 1 s poll,
 *    and at Stop. A change seen at an observation point is credited to whoever
 *    held the browser since the previous one: the agent if one of its ops was
 *    in flight at any time in between (silent baseline sync), else the human.
 *    Agent state only changes at op events, which are themselves observation
 *    points, so an agent navigation that starts and ends between polls is
 *    still attributed to the agent. Observations are held for a human
 *    operation's whole dispatch-to-commit span (one guard, owned by
 *    runOperation) so its step lands before the navigation it causes.
 *
 * 3. A new event merges into the previous step (more typing into the same
 *    field, consecutive scrolls) only if nothing happened
 *    in between (no other step, no URL change by anyone, no agent activity)
 *    and it happens in exactly the same context: the same page object and
 *    the same document (a per-document token captured during inspection; an
 *    unreadable token never merges) at the same URL. One check ({@link BrowserDemoRecorder.extendable})
 *    enforces this for every merge, instead of flags each path must reset.
 *    Merging only ever appends: recorded steps are never edited to simulate
 *    what the browser did (Backspace, caret moves, selections, graphemes),
 *    so corrections are kept as the key steps the human actually pressed.
 *
 * 4. Nothing learned across an await is trusted unchecked. Facts about the
 *    page come from single page reads that return the document token and
 *    the target together, never from separate round trips. Inspection only
 *    counts if the page object, its URL and the agent-activity sequence are
 *    unchanged when it resolves (else re-inspect once, then fail closed).
 *    After delivery, character payloads and scrolls are read again: a
 *    different page object or document means no merge and a masked
 *    payload; moved focus or a sensitive field means a masked payload.
 *    Recordings draining after Stop keep receiving agent activity.
 *
 * Masking fails closed and follows the payload, not the step type: any
 * keyboard input that can put a character into the page (typed text, or a
 * printable key with Ctrl/Alt/Meta) is inspected and confirmed like typing,
 * and stored in the clear only for a focused control positively identified as
 * plain text entry (browser-demo-element.ts). Recorded URLs drop userinfo.
 *
 * A recording is per chat session, capped at {@link DEMO_RECORDING_MAX_MS}, and
 * saved as a JSON session artifact when it stops (Stop button, or the cap).
 */

import {
  codePointCut,
  pageReadScript,
  parsePageRead,
  type PageRead,
  type PageReadMode,
  type DemoElementDescription,
} from './browser-demo-element.js';

export const DEMO_RECORDING_MAX_MS = 10 * 60 * 1000;
export const DEMO_RECORDING_MAX_STEPS = 5_000;
export const DEMO_URL_POLL_MS = 1_000;
export const DEMO_MASKED_TEXT = '••••••••';
export const DEMO_RECORDING_SCHEMA_VERSION = 1;
/** Longest text a single type step holds; longer input continues in further steps. */
export const DEMO_TYPED_TEXT_MAX_CHARS = 2_000;
const DESCRIBE_TIMEOUT_MS = 1_500;

export type DemoStopReason = 'stopped' | 'time_limit';

interface DemoTarget {
  selector: string | null;
  text: string | null;
  tag: string | null;
}

export type DemoStep =
  | { t: number; type: 'navigate'; url: string; source: 'url_bar' | 'page' }
  | ({
      t: number;
      type: 'click';
      url: string | null;
      x: number;
      y: number;
      button: 'left' | 'right' | 'middle';
      clickCount: number;
    } & DemoTarget)
  | ({
      t: number;
      type: 'type';
      url: string | null;
      text: string;
      masked: boolean;
      /** Continues the previous type step's text (input longer than one step holds). */
      continued?: true;
    } & DemoTarget)
  | {
      t: number;
      type: 'key';
      url: string | null;
      /** The key, or the mask when it carries a character into a sensitive or unknown target. */
      key: string;
      modifiers?: string[];
      masked?: true;
    }
  | { t: number; type: 'scroll'; url: string | null; deltaX: number; deltaY: number };

export interface DemoRecording {
  schemaVersion: number;
  kind: 'agent-hub.browser-demo';
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stopReason: DemoStopReason;
  startUrl: string | null;
  truncated: boolean;
  steps: DemoStep[];
}

export interface DemoRecordingState {
  active: boolean;
  startedAt: number | null;
  endsAt: number | null;
  maxDurationMs: number;
  steps: number;
}

export interface DemoSavedArtifact {
  id: string;
  filename: string;
  url: string;
}

export type DemoRecorderEvent =
  | { type: 'state'; sessionId: string; state: DemoRecordingState }
  | {
      type: 'saved';
      sessionId: string;
      artifact: DemoSavedArtifact;
      steps: number;
      stopReason: DemoStopReason;
    }
  | { type: 'save_failed'; sessionId: string; message: string };

/** Input as the screencast forwards it (structurally the pane's BrowserViewerInput). */
export type DemoViewerInput =
  | {
      kind: 'mouse';
      type: 'move' | 'down' | 'up' | 'click';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | {
      kind: 'key';
      type: 'press' | 'down' | 'up';
      key: string;
      modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean };
    }
  | { kind: 'text'; text: string };

/** Minimal page surface the recorder needs to inspect targets. */
export interface DemoPageLike {
  url(): string;
  evaluate(script: string): Promise<unknown>;
}

export interface DemoRecorderDeps {
  /** URL of the Chromium the pane is driving for this chat session, or null. */
  currentUrl: (chatSessionId: string) => string | null;
  /** True while an agent step is in flight (its URL changes are not the human's). */
  isAgentDriving: (chatSessionId: string) => boolean;
  /** Persist a finished recording (a session artifact in production). */
  save: (recording: DemoRecording) => Promise<DemoSavedArtifact>;
  now: () => number;
}

/** What a viewer input will record, resolved before the input is dispatched. */
type PendingDemoStep =
  | {
      kind: 'click';
      target: DemoTarget;
      x: number;
      y: number;
      button: 'left' | 'right' | 'middle';
      clickCount: number;
    }
  | { kind: 'text'; text: string; target: DemoElementDescription }
  | {
      kind: 'key';
      key: string;
      modifiers: string[];
      /** Set when the key can carry a character: where that character lands. */
      target: DemoElementDescription | null;
    }
  | { kind: 'scroll'; deltaX: number; deltaY: number };

interface ActiveRecording {
  sessionId: string;
  startedAt: number;
  startUrl: string | null;
  /** URL as of the last observation point. */
  lastUrl: string | null;
  steps: DemoStep[];
  truncated: boolean;
  /**
   * Advances on every step, every URL change (whoever caused it) and any
   * agent activity. A step can only be extended while the epoch it was
   * written at is still current, i.e. nothing at all happened since.
   */
  epoch: number;
  stepEpochs: WeakMap<DemoStep, number>;
  /**
   * Context (page object + document) each step was written in. A step can
   * only be extended by an operation in exactly the same context.
   */
  stepContexts: WeakMap<DemoStep, string>;
  /** Context of the operation currently committing; steps pushed now carry it. */
  opContext: string | null;
  /** Agent op in flight as of the last observation point. */
  agentDriving: boolean;
  /** An agent op was in flight at some point since the last observation point. */
  agentTouched: boolean;
  /**
   * A human operation is between dispatch and commit. Observations wait so
   * its step lands before anything it caused. Only {@link runOperation} sets
   * and clears it.
   */
  operationInFlight: boolean;
  /**
   * Started while an earlier recording's operations were still queued: the
   * URL baseline is taken once they settle, so their effects are not credited
   * to this recording.
   */
  awaitingBaseline: boolean;
  capTimer: ReturnType<typeof setTimeout>;
  pollTimer: ReturnType<typeof setInterval>;
  stopping: boolean;
  /** Settles once every operation accepted into this recording has finished. */
  inFlight: Promise<unknown>;
}

const UNKNOWN_FOCUS: DemoElementDescription = {
  selector: null,
  text: null,
  tag: null,
  sensitive: true,
};

function targetFields(d: DemoElementDescription | null): DemoTarget {
  return { selector: d?.selector ?? null, text: d?.text ?? null, tag: d?.tag ?? null };
}

function sameTarget(a: DemoTarget, b: DemoTarget): boolean {
  return a.selector === b.selector && a.tag === b.tag;
}

function modifierList(m: DemoViewerInput & { kind: 'key' }): string[] {
  const out: string[] = [];
  if (m.modifiers?.ctrl) out.push('Control');
  if (m.modifiers?.alt) out.push('Alt');
  if (m.modifiers?.meta) out.push('Meta');
  if (m.modifiers?.shift) out.push('Shift');
  return out;
}

const UNREADABLE: PageRead = { doc: null, target: null };

/**
 * One round trip to the page: the document token plus the requested target,
 * read together so they always describe the same document.
 */
async function readPage(page: DemoPageLike | null, mode: PageReadMode): Promise<PageRead> {
  if (!page) return UNREADABLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      page.evaluate(pageReadScript(mode)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS);
      }),
    ]);
    return parsePageRead(raw);
  } catch {
    return UNREADABLE;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keys that never put a character into the page. Every other key (any
 * printable key, with or without Ctrl/Alt/Meta, e.g. an AltGr character
 * arriving as Ctrl+Alt) may carry one and is treated as a text payload.
 */
const NON_CHARACTER_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ContextMenu',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Pause',
  'PrintScreen',
  ...Array.from({ length: 24 }, (_, n) => `F${n + 1}`),
]);

function keyCarriesCharacter(key: string): boolean {
  return !NON_CHARACTER_KEYS.has(key);
}

/** Pending steps whose payload is characters landing in a focused target. */
function characterTarget(pending: PendingDemoStep): DemoElementDescription | null {
  if (pending.kind === 'text') return pending.target;
  if (pending.kind === 'key') return pending.target;
  return null;
}

/** Recorded URLs never keep userinfo (`user:pass@host`). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Drop whatever inspection claimed about the target: unknown focus is masked. */
function failClosed(pending: PendingDemoStep | null): PendingDemoStep | null {
  if (!pending) return null;
  if (pending.kind === 'text') {
    return { ...pending, target: UNKNOWN_FOCUS };
  }
  if (pending.kind === 'key' && pending.target) return { ...pending, target: UNKNOWN_FOCUS };
  if (pending.kind === 'click') return { ...pending, target: targetFields(null) };
  return pending;
}

/**
 * Inspect what an input targets, before it is dispatched, in one page read.
 * Focus is looked up for every character payload, never cached: page script
 * can move focus (say, into a password field) without a click or Tab.
 * Returns a null step when the input records nothing.
 */
async function prepare(
  page: DemoPageLike | null,
  input: DemoViewerInput,
): Promise<{ pending: PendingDemoStep | null; doc: string | null }> {
  const focus = async () => {
    const r = await readPage(page, { kind: 'focus' });
    return { target: r.target ?? UNKNOWN_FOCUS, doc: r.doc };
  };
  switch (input.kind) {
    case 'mouse': {
      if (input.type !== 'down' && input.type !== 'click') return { pending: null, doc: null };
      const r = await readPage(page, { kind: 'point', x: input.x, y: input.y });
      return {
        doc: r.doc,
        pending: {
          kind: 'click',
          target: targetFields(r.target),
          x: Math.round(input.x),
          y: Math.round(input.y),
          button: input.button ?? 'left',
          clickCount: input.clickCount ?? 1,
        },
      };
    }
    case 'wheel': {
      const r = await readPage(page, { kind: 'none' });
      return {
        doc: r.doc,
        pending: { kind: 'scroll', deltaX: input.deltaX, deltaY: input.deltaY },
      };
    }
    case 'text': {
      const { target, doc } = await focus();
      return { doc, pending: { kind: 'text', text: input.text, target } };
    }
    case 'key': {
      if (input.type === 'up') return { pending: null, doc: null };
      const modifiers = modifierList(input);
      const chord = modifiers.some((m) => m !== 'Shift');
      if (input.key.length === 1 && !chord) {
        const { target, doc } = await focus();
        return { doc, pending: { kind: 'text', text: input.key, target } };
      }
      if (keyCarriesCharacter(input.key)) {
        const { target, doc } = await focus();
        return { doc, pending: { kind: 'key', key: input.key, modifiers, target } };
      }
      const r = await readPage(page, { kind: 'none' });
      return { doc: r.doc, pending: { kind: 'key', key: input.key, modifiers, target: null } };
    }
    default:
      return { pending: null, doc: null };
  }
}

export class BrowserDemoRecorder {
  private readonly active = new Map<string, ActiveRecording>();
  private readonly listeners = new Set<(ev: DemoRecorderEvent) => void>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Stopped recordings still finishing accepted operations; they keep hearing agent activity. */
  private readonly draining = new Set<ActiveRecording>();
  /** Per chat session, bumped on every agent op start/end, recording or not. */
  private readonly agentActivitySeq = new Map<string, number>();
  private deps: DemoRecorderDeps;

  constructor(deps: Partial<DemoRecorderDeps> = {}) {
    this.deps = {
      currentUrl: () => null,
      isAgentDriving: () => false,
      save: async () => {
        throw new Error('Demo recordings cannot be saved: no artifact store is configured');
      },
      now: () => Date.now(),
      ...deps,
    };
  }

  configure(deps: Partial<DemoRecorderDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  subscribe(listener: (ev: DemoRecorderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRecording(sessionId: string): boolean {
    return this.current(sessionId) !== null;
  }

  state(sessionId: string): DemoRecordingState {
    const rec = this.current(sessionId);
    if (!rec) {
      return {
        active: false,
        startedAt: null,
        endsAt: null,
        maxDurationMs: DEMO_RECORDING_MAX_MS,
        steps: 0,
      };
    }
    return {
      active: true,
      startedAt: rec.startedAt,
      endsAt: rec.startedAt + DEMO_RECORDING_MAX_MS,
      maxDurationMs: DEMO_RECORDING_MAX_MS,
      steps: rec.steps.length,
    };
  }

  start(
    sessionId: string,
  ): { ok: true; state: DemoRecordingState } | { ok: false; message: string } {
    if (this.active.has(sessionId)) {
      return { ok: false, message: 'A demo is already being recorded in this session.' };
    }
    const startUrl = this.safeUrl(sessionId);
    const capTimer = setTimeout(() => {
      void this.stop(sessionId, 'time_limit');
    }, DEMO_RECORDING_MAX_MS);
    capTimer.unref?.();
    const rec: ActiveRecording = {
      sessionId,
      startedAt: this.deps.now(),
      startUrl,
      lastUrl: startUrl,
      steps: [],
      truncated: false,
      epoch: 0,
      stepEpochs: new WeakMap(),
      stepContexts: new WeakMap(),
      opContext: null,
      agentDriving: this.agentDriving(sessionId),
      agentTouched: false,
      operationInFlight: false,
      awaitingBaseline: false,
      capTimer,
      pollTimer: setInterval(() => this.observe(rec), DEMO_URL_POLL_MS),
      stopping: false,
      inFlight: Promise.resolve(),
    };
    rec.pollTimer.unref?.();
    this.active.set(sessionId, rec);
    const queued = this.queues.get(sessionId);
    if (queued) {
      rec.awaitingBaseline = true;
      // Registered before any of this recording's own operations, so it runs
      // first; Stop waits for it like any accepted operation.
      rec.inFlight = queued.then(() => {
        rec.awaitingBaseline = false;
        rec.startUrl = rec.lastUrl = this.safeUrl(sessionId);
        rec.agentDriving = this.agentDriving(sessionId);
        rec.agentTouched = false;
      });
    }
    const state = this.state(sessionId);
    this.emit({ type: 'state', sessionId, state });
    return { ok: true, state };
  }

  /** Stop and save. Resolves to null when nothing was recording. */
  async stop(sessionId: string, reason: DemoStopReason = 'stopped'): Promise<DemoRecording | null> {
    const rec = this.current(sessionId);
    if (!rec) return null;
    rec.stopping = true;
    clearTimeout(rec.capTimer);
    clearInterval(rec.pollTimer);
    const endedAt = this.deps.now();
    // Free the session right away (a new recording may start, and later
    // operations are not part of this one), then let operations accepted
    // before Stop finish so their steps land in this recording.
    this.active.delete(sessionId);
    this.draining.add(rec);
    this.emit({ type: 'state', sessionId, state: this.state(sessionId) });
    try {
      await rec.inFlight;
      this.observe(rec);
    } finally {
      this.draining.delete(rec);
    }
    const recording: DemoRecording = {
      schemaVersion: DEMO_RECORDING_SCHEMA_VERSION,
      kind: 'agent-hub.browser-demo',
      sessionId,
      startedAt: new Date(rec.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: Math.min(DEMO_RECORDING_MAX_MS, endedAt - rec.startedAt),
      stopReason: reason,
      startUrl: rec.startUrl,
      truncated: rec.truncated,
      steps: rec.steps,
    };
    try {
      const artifact = await this.deps.save(recording);
      this.emit({
        type: 'saved',
        sessionId,
        artifact,
        steps: recording.steps.length,
        stopReason: reason,
      });
    } catch (err) {
      this.emit({
        type: 'save_failed',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return recording;
  }

  /**
   * Run a viewer input through the session queue: inspect its target on the
   * page as it is when the input's turn comes, dispatch it, and record it if
   * the browser accepted it. `getPage` and `dispatch` run inside the queue so
   * they see the browser after every earlier operation has landed.
   */
  record<T extends { ok: boolean }>(
    sessionId: string,
    input: DemoViewerInput,
    getPage: () => DemoPageLike | null,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(sessionId, async (rec) => {
      if (!rec) return dispatch();
      const { pending, page, doc } = await this.inspect(sessionId, input, getPage);
      return this.runOperation(rec, async (at) => {
        const result = await dispatch();
        if (result.ok && pending) {
          const settled = await this.confirm(pending, { page, doc }, getPage);
          const context = settled.context;
          rec.opContext = context;
          try {
            this.commit(rec, settled.pending, at, context);
          } finally {
            rec.opContext = null;
          }
        }
        return result;
      });
    });
  }

  /** Run a URL-bar navigation from the pane through the same session queue. */
  recordNavigation<T extends { ok: true; url: string } | { ok: false }>(
    sessionId: string,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(sessionId, async (rec) => {
      if (!rec) return dispatch();
      return this.runOperation(rec, async () => {
        const result = await dispatch();
        if (result.ok) {
          rec.lastUrl = redactUrl(result.url);
          this.push(rec, {
            t: this.deps.now() - rec.startedAt,
            type: 'navigate',
            url: rec.lastUrl,
            source: 'url_bar',
          });
        }
        return result;
      });
    });
  }

  /**
   * An agent op started or ended on one of this chat session's Chromiums.
   * Credits URL changes up to now by the agent state that held until now,
   * then takes the new state.
   */
  observeAgentActivity(sessionId: string): void {
    this.agentActivitySeq.set(sessionId, (this.agentActivitySeq.get(sessionId) ?? 0) + 1);
    const driving = this.agentDriving(sessionId);
    const recs = [...this.draining].filter((r) => r.sessionId === sessionId);
    const live = this.active.get(sessionId);
    if (live) recs.push(live);
    for (const rec of recs) {
      if (rec.operationInFlight || rec.awaitingBaseline) {
        // Keep the human operation's step ahead of anything it caused; the
        // observation after it runs will see the agent overlapped it.
        if (driving) rec.agentTouched = true;
        continue;
      }
      this.observe(rec);
    }
  }

  /** Test-only: cancel every recording without saving. */
  resetForTests(): void {
    for (const rec of this.active.values()) {
      clearTimeout(rec.capTimer);
      clearInterval(rec.pollTimer);
    }
    this.active.clear();
    this.draining.clear();
    this.agentActivitySeq.clear();
    this.listeners.clear();
    this.queues.clear();
  }

  /**
   * Inspect an input's target. What inspection learns is only trusted if the
   * browser it looked at is still the one the input will reach: same page
   * object, same URL, and no agent op started or ended while it ran. If that
   * changed, inspect once more; if it changed again, fail closed (typing is
   * masked, a click loses its target description).
   */
  private async inspect(
    sessionId: string,
    input: DemoViewerInput,
    getPage: () => DemoPageLike | null,
  ): Promise<{ pending: PendingDemoStep | null; page: DemoPageLike | null; doc: string | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = getPage();
      const before = this.browserSnapshot(sessionId, page);
      const { pending, doc } = await prepare(page, input);
      if (this.browserSnapshot(sessionId, getPage()) === before) return { pending, page, doc };
    }
    const { pending } = await prepare(null, input);
    return { pending: failClosed(pending), page: null, doc: null };
  }

  /**
   * Identity of where an operation happened: the page object and the
   * document in it. An unreadable document gets a key no other operation
   * shares, so it never merges with anything.
   */
  private contextKey(page: DemoPageLike | null, doc: string | null): string {
    const docPart = doc ?? `unknown-${this.nextUnknownContext++}`;
    return `${this.pageId(page)}|${docPart}`;
  }

  private nextUnknownContext = 1;

  /**
   * After delivery, settle what the step may claim. Character payloads and
   * scrolls (the inputs whose recording depends on staying in one place) get
   * one more page read: if the page object or document is not the one
   * inspection saw, the step gets a context no other step shares (no merge)
   * and a character payload is masked; if focus moved or the field is
   * sensitive, the payload is masked. This only ever adds masking.
   */
  private async confirm(
    pending: PendingDemoStep,
    seen: { page: DemoPageLike | null; doc: string | null },
    getPage: () => DemoPageLike | null,
  ): Promise<{ pending: PendingDemoStep; context: string }> {
    const chars = characterTarget(pending);
    if (!chars && pending.kind !== 'scroll') {
      return { pending, context: this.contextKey(seen.page, seen.doc) };
    }
    const page = getPage();
    const after = await readPage(page, chars ? { kind: 'focus' } : { kind: 'none' });
    const sameDocument = page === seen.page && after.doc !== null && after.doc === seen.doc;
    const masked = { ...pending, target: UNKNOWN_FOCUS } as PendingDemoStep;
    if (!sameDocument) {
      return { pending: chars ? masked : pending, context: this.contextKey(null, null) };
    }
    const context = this.contextKey(seen.page, seen.doc);
    if (!chars || chars.sensitive) return { pending, context };
    const now = after.target ?? UNKNOWN_FOCUS;
    if (!now.sensitive && sameTarget(targetFields(now), targetFields(chars))) {
      return { pending, context };
    }
    return { pending: masked, context };
  }

  private browserSnapshot(sessionId: string, page: DemoPageLike | null): string {
    let url: string | null = null;
    try {
      url = page ? page.url() : null;
    } catch {
      url = null;
    }
    // Page identity can't be serialized; pair it with a stable id per page object.
    return `${this.pageId(page)}|${url}|${this.agentActivitySeq.get(sessionId) ?? 0}|${this.agentDriving(sessionId)}`;
  }

  private readonly pageIds = new WeakMap<object, number>();
  private nextPageId = 1;
  private pageId(page: DemoPageLike | null): number {
    if (!page) return 0;
    let id = this.pageIds.get(page);
    if (!id) {
      id = this.nextPageId++;
      this.pageIds.set(page, id);
    }
    return id;
  }

  private current(sessionId: string): ActiveRecording | null {
    const rec = this.active.get(sessionId);
    return rec && !rec.stopping ? rec : null;
  }

  /**
   * Serialize an operation behind the session's earlier ones. The recording
   * is captured when the operation is accepted; null means not recording.
   * With nothing recording and nothing queued it runs immediately.
   */
  private enqueue<T>(
    sessionId: string,
    job: (rec: ActiveRecording | null) => Promise<T>,
  ): Promise<T> {
    const rec = this.current(sessionId);
    const prev = this.queues.get(sessionId);
    if (!rec && !prev) return job(null);
    const run = (prev ?? Promise.resolve()).then(() => job(rec));
    const tail = run.catch(() => undefined);
    if (rec) rec.inFlight = tail;
    this.queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return run;
  }

  /** Observe, then pin the operation to the page it starts on and hold observations. */
  /**
   * The only place a human operation's observation guard is held. Observe
   * first (changes before the operation precede it), pin the step to the page
   * it starts on, then hold observations through everything the operation
   * awaits (dispatch, post-input checks, commit) and release in `finally`.
   * The follow-up observation records what the operation caused, after it.
   */
  private async runOperation<T>(
    rec: ActiveRecording,
    body: (at: { url: string | null; t: number }) => Promise<T>,
  ): Promise<T> {
    this.observe(rec);
    const at = { url: rec.lastUrl, t: this.deps.now() - rec.startedAt };
    rec.operationInFlight = true;
    try {
      return await body(at);
    } finally {
      rec.operationInFlight = false;
      this.observe(rec);
    }
  }

  /**
   * Observation point: credit any URL change since the previous one, then
   * take the current agent state. Held while a human operation dispatches.
   */
  private observe(rec: ActiveRecording): void {
    if (rec.operationInFlight || rec.awaitingBaseline) return;
    const url = this.safeUrl(rec.sessionId);
    const agentHeldBrowser = rec.agentDriving || rec.agentTouched;
    // The agent acted, or the page changed: nothing before this may be extended.
    if (agentHeldBrowser) rec.epoch += 1;
    if (url && url !== rec.lastUrl) {
      rec.epoch += 1;
      rec.lastUrl = url;
      if (!agentHeldBrowser) {
        this.push(rec, {
          t: this.deps.now() - rec.startedAt,
          type: 'navigate',
          url,
          source: 'page',
        });
      }
    }
    rec.agentDriving = this.agentDriving(rec.sessionId);
    rec.agentTouched = false;
  }

  /** Record a prepared step into the recording it was accepted by. */
  private commit(
    rec: ActiveRecording,
    pending: PendingDemoStep,
    at: { url: string | null; t: number },
    context: string,
  ): void {
    const { url, t } = at;
    const last = this.extendable(rec, url, context);

    if (pending.kind === 'text') {
      const masked = pending.target.sensitive;
      const target = targetFields(pending.target);
      let rest = pending.text;
      if (last?.type === 'type' && last.masked === masked && sameTarget(last, target)) {
        if (masked) {
          this.emitState(rec);
          return;
        }
        const room = codePointCut(rest, DEMO_TYPED_TEXT_MAX_CHARS - last.text.length);
        last.text += rest.slice(0, room);
        rest = rest.slice(room);
        if (!rest) {
          this.emitState(rec);
          return;
        }
        this.pushText(rec, { t, url, target, masked, text: rest, continued: true });
        return;
      }
      this.pushText(rec, {
        t,
        url,
        target,
        masked,
        text: masked ? DEMO_MASKED_TEXT : rest,
        continued: false,
      });
      return;
    }

    if (pending.kind === 'scroll') {
      if (last?.type === 'scroll') {
        last.deltaX += pending.deltaX;
        last.deltaY += pending.deltaY;
        return;
      }
      this.push(rec, { t, type: 'scroll', url, deltaX: pending.deltaX, deltaY: pending.deltaY });
      return;
    }

    if (pending.kind === 'click') {
      this.push(rec, {
        t,
        type: 'click',
        url,
        ...pending.target,
        x: pending.x,
        y: pending.y,
        button: pending.button,
        clickCount: pending.clickCount,
      });
      return;
    }
    const masked = Boolean(pending.target?.sensitive);
    this.push(rec, {
      t,
      type: 'key',
      url,
      key: masked ? DEMO_MASKED_TEXT : pending.key,
      ...(pending.modifiers.length ? { modifiers: pending.modifiers } : {}),
      ...(masked ? { masked: true as const } : {}),
    });
  }

  /**
   * Store typed text without losing any: text longer than one step holds is
   * split across continuation steps for the same target, never inside a
   * surrogate pair.
   */
  private pushText(
    rec: ActiveRecording,
    p: {
      t: number;
      url: string | null;
      target: DemoTarget;
      masked: boolean;
      text: string;
      continued: boolean;
    },
  ): void {
    let rest = p.text;
    let continued = p.continued;
    do {
      const cut = codePointCut(rest, DEMO_TYPED_TEXT_MAX_CHARS) || rest.length;
      this.push(rec, {
        t: p.t,
        type: 'type',
        url: p.url,
        ...p.target,
        text: rest.slice(0, cut),
        masked: p.masked,
        ...(continued ? { continued: true as const } : {}),
      });
      rest = rest.slice(cut);
      continued = true;
    } while (rest && !rec.truncated);
  }

  private agentDriving(sessionId: string): boolean {
    try {
      return this.deps.isAgentDriving(sessionId);
    } catch {
      return false;
    }
  }

  private safeUrl(sessionId: string): string | null {
    try {
      const u = this.deps.currentUrl(sessionId);
      return typeof u === 'string' && u && u !== 'about:blank' ? redactUrl(u) : null;
    } catch {
      return null;
    }
  }

  /**
   * The last step, if this operation may merge into it: nothing happened
   * since it was written (no other step, URL change or agent activity, and
   * no agent op overlapping this dispatch), and it was written in exactly
   * this operation's context (same page object and document) and URL.
   * Every merge (typing, scroll) goes through here.
   */
  private extendable(rec: ActiveRecording, url: string | null, context: string): DemoStep | null {
    const last = rec.steps[rec.steps.length - 1];
    if (!last || rec.agentTouched) return null;
    if (rec.stepEpochs.get(last) !== rec.epoch) return null;
    if (rec.stepContexts.get(last) !== context) return null;
    if (!('url' in last) || last.url !== url) return null;
    return last;
  }

  private push(rec: ActiveRecording, step: DemoStep): void {
    rec.epoch += 1;
    if (rec.steps.length >= DEMO_RECORDING_MAX_STEPS) {
      rec.truncated = true;
      return;
    }
    rec.steps.push(step);
    rec.stepEpochs.set(step, rec.epoch);
    if (rec.opContext) rec.stepContexts.set(step, rec.opContext);
    this.emitState(rec);
  }

  private emitState(rec: ActiveRecording): void {
    // A recording draining after Stop no longer owns the session's state.
    if (this.active.get(rec.sessionId) !== rec) return;
    this.emit({ type: 'state', sessionId: rec.sessionId, state: this.state(rec.sessionId) });
  }

  private emit(ev: DemoRecorderEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a broken listener must not stop the recording */
      }
    }
  }
}

export const browserDemoRecorder = new BrowserDemoRecorder();

/** `browser-demo-20261016-134501.json` (UTC). */
export function demoRecordingFilename(startedAtIso: string): string {
  const stamp = startedAtIso
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return `browser-demo-${stamp}.json`;
}

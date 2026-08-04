/**
 * Console + network capture for session replays.
 *
 * rrweb records the DOM, not the runtime. A replay therefore shows *that* a
 * user rage-clicked a button but never *why* — the `TypeError` that fired one
 * tick earlier, or the `500` the click's request came back with, is nowhere in
 * the capture. That gap is what makes a replay near-useless to an agent trying
 * to fix a customer's bug: the best timeline you can derive from DOM mutations
 * alone is a mouse-movement diary.
 *
 * This module closes it by emitting rrweb **Custom** events (`type: 5`)
 * alongside the DOM stream, so console errors/warnings, uncaught exceptions,
 * unhandled rejections, and fetch/XHR outcomes are interleaved into the same
 * timestamp-ordered event list the rest of the replay already flows through.
 * Nothing downstream needs to change: the buffer, the pruner, the continuous
 * flusher, the ingest endpoint, and the rrweb player all handle custom events
 * natively (the player ignores tags it doesn't know).
 *
 * Deliberately dependency-free (no rrweb import): the recorder injects the
 * emit function, so every helper here is pure or DOM-injectable and unit
 * testable without a browser or a real rrweb instance.
 *
 * ## Privacy
 * This is customer telemetry, so capture is deliberately narrow:
 *  - **Never** request/response bodies or headers. Only method, redacted URL,
 *    status, and duration.
 *  - URLs keep origin + path; query VALUES are dropped unless they're short and
 *    opaque-looking, and sensitive keys (token, password, email, …) are always
 *    masked. `user:pass@` credentials and the fragment are stripped entirely.
 *  - Every emitted string runs through {@link redactSensitiveText}, which masks
 *    bearer tokens, JWTs, `sk-`-style API keys, `access_token=`-style
 *    assignments in either naming convention, long hex/base64 blobs, and email
 *    addresses — and puts any URL embedded in a message or stack frame through
 *    the same query-masking as a captured request URL.
 *  - Volume is bounded by a token bucket + a hard per-page cap so a hot error
 *    loop can't evict the DOM events out of the rolling buffer.
 */

/** rrweb `EventType.Custom`. Inlined so this module imports nothing from rrweb. */
export const RRWEB_CUSTOM_EVENT_TYPE = 5;

/** Custom-event tag for a console / uncaught-error entry. */
export const REPLAY_CONSOLE_TAG = 'agent-hub/console';
/** Custom-event tag for a network (fetch / XHR) entry. */
export const REPLAY_NETWORK_TAG = 'agent-hub/network';

/** Console levels captured by default. `log`/`debug` are excluded: they're high
 *  volume and low signal, and would crowd out DOM events in the rolling buffer. */
export const DEFAULT_CONSOLE_LEVELS = ['error', 'warn'] as const;

/** Max characters kept for one console message after redaction. */
export const MAX_CONSOLE_MESSAGE_CHARS = 800;
/** Max characters kept for one redacted URL. */
export const MAX_URL_CHARS = 512;
/** Max stack frames appended to a captured Error / uncaught exception. */
export const MAX_STACK_FRAMES = 3;
/** Token-bucket window for telemetry emission. */
export const RATE_WINDOW_MS = 10_000;
/** Max telemetry events emitted per {@link RATE_WINDOW_MS}. */
export const MAX_EVENTS_PER_WINDOW = 60;
/** Hard ceiling on telemetry events emitted for the life of the page. */
export const MAX_EVENTS_PER_PAGE = 1000;

export type ConsoleLevel = 'error' | 'warn' | 'info' | 'log' | 'debug';

export interface ReplayConsolePayload {
  level: ConsoleLevel | 'exception' | 'unhandledrejection';
  message: string;
  /** Present for exceptions/rejections and captured `Error` arguments. */
  stack?: string;
}

export interface ReplayNetworkPayload {
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  /** HTTP status, or 0 when the request failed before a response. */
  status: number;
  durationMs: number;
  /** Set when the request rejected/errored instead of returning a response. */
  error?: string;
}

/** Emitter supplied by the recorder: receives a ready-made rrweb custom event. */
export type ReplayCustomEventEmitter = (event: {
  type: number;
  timestamp: number;
  data: { tag: string; payload: unknown };
}) => void;

// ─── Redaction ────────────────────────────────────────────────────

/**
 * Query-string keys whose value is always masked, matched case-insensitively as
 * a substring so `X-Auth-Token`, `access_token`, and `apiKey` all hit.
 */
const SENSITIVE_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'apikey',
  'api_key',
  'key',
  'session',
  'sig',
  'signature',
  'credential',
  'email',
  'phone',
  'ssn',
];

/** A query value safe to keep verbatim: short and opaque (ids, page numbers,
 *  enum-ish flags). Anything longer or with punctuation is masked. */
const SAFE_QUERY_VALUE_RE = /^[A-Za-z0-9_-]{1,16}$/;

const REDACTED = '[redacted]';

/**
 * Key names in `key=value` / `"key": "value"` assignments whose value is
 * masked, derived from {@link SENSITIVE_KEY_PATTERNS} so the free-text rule and
 * the URL-query rule can never drift apart.
 *
 * The surrounding matcher allows separator-delimited affixes, which is what
 * makes `access_token=`, `x-auth-token:`, and `session.id=` match while
 * `monkey=banana` does not (its `key` is neither at the start of the name nor
 * preceded by `_`/`-`/`.`). Longest-first so `password` wins over `pwd` and
 * `apikey` over `key`.
 */
const SENSITIVE_ASSIGNMENT_CORE = [...SENSITIVE_KEY_PATTERNS]
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Build an assignment matcher for a key-name pattern.
 *
 * The value side has three branches, in order:
 *  1. **Quoted** — consumes the WHOLE quoted run, including spaces and commas,
 *     and tolerates backslash escapes. Without this, `password="my secret"`
 *     matched nothing at all (the closing-quote backreference failed after the
 *     value stopped at the space), so the secret shipped verbatim.
 *  2. **Unterminated quote** — masks to end of line rather than giving up.
 *  3. **Bare** — an unquoted run, stopping at whitespace/quote/`,`/`;`/`&`.
 *
 * The bare branch carries `(?!\[redacted\])` so the rule is idempotent: without
 * it a second pass over `token=[redacted]:1421:19` would re-match and swallow
 * the stack frame's `:line:col` suffix. The quoted branches are naturally
 * idempotent — re-masking `"[redacted]"` reproduces it exactly.
 */
function buildAssignmentMatcher(keyPattern: string, flags: string): RegExp {
  return new RegExp(
    `(?<lead>^|[^A-Za-z0-9._-])` +
      `(?<key>${keyPattern})` +
      // The optional quote closes a QUOTED key (`"access_token": …`), which is
      // how a serialized JSON payload reaches a console message.
      `(?<sep>["']?\\s*[:=]\\s*)` +
      `(?:` +
      // 1 + 2: quoted, closed by the matching quote, a newline, or end of input.
      `(?<q>["'])(?<quoted>(?:\\\\.|(?!\\k<q>)[^\\\\\\n])*)(?:\\k<q>|(?=\\n)|$)` +
      `|` +
      // 3: bare.
      `(?<bare>(?!\\[redacted\\])[^\\s"',;&]+)` +
      `)`,
    flags,
  );
}

/** Mask an assignment's value while preserving its key, separator, and quoting. */
function maskAssignment(...args: unknown[]): string {
  const groups = args[args.length - 1] as Record<string, string | undefined>;
  const lead = groups.lead ?? '';
  const head = `${lead}${groups.key ?? ''}${groups.sep ?? ''}`;
  const quote = groups.q;
  return quote ? `${head}${quote}${REDACTED}${quote}` : `${head}${REDACTED}`;
}

/** `access_token=…`, `X-Auth-Token: …`, `api_key = '…'` (case-insensitive). */
const SENSITIVE_ASSIGNMENT_RE = buildAssignmentMatcher(
  `(?:[A-Za-z0-9]+[._-])*(?:${SENSITIVE_ASSIGNMENT_CORE})(?:[._-][A-Za-z0-9]+)*`,
  'gi',
);

/**
 * camelCase equivalent (`accessToken: 'abc'`, `apiKey=…`). Case-SENSITIVE: the
 * capitalized core is exactly what marks the word boundary the separator-based
 * matcher above relies on, so `monkey=` still slips past while `monKey=` does
 * not — an acceptable trade in a redactor that errs toward masking.
 */
const SENSITIVE_CAMEL_ASSIGNMENT_RE = buildAssignmentMatcher(
  '[A-Za-z0-9]*(?:Token|Secret|Password|Passwd|Pwd|Auth|ApiKey|Key|Session|Signature|Sig|Credential|Email|Phone|Ssn)',
  'g',
);

/** Absolute URLs embedded in free text (console messages, stack frames). */
const URL_IN_TEXT_RE = /https?:\/\/[^\s'"<>)\]]+/gi;

interface SecretPattern {
  re: RegExp;
  /** String template, or a replacer for patterns that must inspect their match. */
  replacement: string | ((...args: unknown[]) => string);
}

/**
 * Secret / PII shapes masked out of every captured string. Ordered most
 * specific first so a bearer token isn't first mangled by the generic
 * long-blob rule.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // `Authorization: Bearer <token>` and friends.
  { re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  // JWTs (three base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: REDACTED },
  // Vendor-prefixed API keys (sk-…, pk_live_…, ghp_…, xoxb-…, AKIA…).
  {
    re: /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[baprs]|AKIA)[-_][A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  // `password=…` / `"access_token": "…"` style assignments, both naming styles.
  { re: SENSITIVE_ASSIGNMENT_RE, replacement: maskAssignment },
  { re: SENSITIVE_CAMEL_ASSIGNMENT_RE, replacement: maskAssignment },
  // Email addresses (PII, not a secret, but never worth shipping to an agent).
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[email]' },
  // Long opaque blobs (hex digests, base64 payloads) that survived the above.
  { re: /\b[A-Fa-f0-9]{32,}\b/g, replacement: REDACTED },
  { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replacement: REDACTED },
];

/** Run the secret/PII shape matchers. Shared by free-text and URL redaction. */
function applySecretPatterns(input: string): string {
  let out = input;
  for (const { re, replacement } of SECRET_PATTERNS) {
    // Each pattern carries `g`; reset lastIndex so a shared regex can't skip
    // matches across calls.
    re.lastIndex = 0;
    out =
      typeof replacement === 'function'
        ? out.replace(re, replacement as (...a: string[]) => string)
        : out.replace(re, replacement);
  }
  return out;
}

/**
 * Put every absolute URL found in free text through the SAME treatment a
 * captured request URL gets ({@link redactUrlForReplay}): query values masked,
 * credentials and fragment stripped.
 *
 * This is the rule that catches a `?access_token=…` sitting inside a console
 * message or an exception stack frame — the shape-based matchers alone never
 * saw those, because a stack frame is just a string to them.
 */
function redactUrlsInText(input: string): string {
  URL_IN_TEXT_RE.lastIndex = 0;
  return input.replace(URL_IN_TEXT_RE, (match) => {
    // A stack frame appends `:line:col` to the URL — that suffix is the most
    // useful part of the line, so split it off and put it back afterwards.
    const frame = /:(\d+):(\d+)$/.exec(match);
    const withoutFrame = frame ? match.slice(0, frame.index) : match;
    // Sentence punctuation isn't part of the URL either.
    const punct = /[.,;:!?]+$/.exec(withoutFrame);
    const url = punct ? withoutFrame.slice(0, punct.index) : withoutFrame;
    const tail = `${punct ? punct[0] : ''}${frame ? frame[0] : ''}`;
    return `${redactUrlForReplay(url)}${tail}`;
  });
}

/**
 * Mask secrets and PII in an arbitrary captured string. Best-effort and
 * deliberately over-eager: a masked-but-useless log line is a far cheaper
 * failure than a customer's bearer token landing in an agent's context window.
 *
 * Two passes: embedded URLs are redacted as URLs (so query secrets are caught
 * structurally), then the secret/PII shape matchers run over what's left.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return '';
  return applySecretPatterns(redactUrlsInText(input));
}

/**
 * Reduce a URL to the part that helps debugging and drops the part that leaks:
 * origin + path are kept, credentials and the fragment are removed, and query
 * values are masked unless they're short and opaque (see
 * {@link SAFE_QUERY_VALUE_RE}). Query KEYS are always kept — knowing a request
 * carried `?token=` is diagnostic; knowing its value is a liability.
 *
 * Falls back to a redacted, truncated raw string when the input can't be parsed
 * as a URL (relative paths are resolved against `base` when supplied).
 *
 * Applies the secret matchers directly rather than calling
 * {@link redactSensitiveText}, which would recurse back into here through its
 * embedded-URL pass.
 */
export function redactUrlForReplay(raw: unknown, base?: string): string {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text) return '';
  let url: URL | null = null;
  try {
    url = new URL(text, base || undefined);
  } catch {
    url = null;
  }
  if (!url) {
    return truncate(applySecretPatterns(text.split('#')[0] ?? ''), MAX_URL_CHARS);
  }
  // Strip embedded credentials — `https://user:pass@host/…` is a real shape in
  // legacy integrations and would otherwise be captured verbatim.
  url.username = '';
  url.password = '';
  url.hash = '';

  const params = Array.from(url.searchParams.entries());
  let query = '';
  if (params.length) {
    query = params
      .map(([key, value]) => {
        const safeKey = truncate(key, 64);
        if (!value) return `${safeKey}=`;
        if (isSensitiveKey(key)) return `${safeKey}=${REDACTED}`;
        return SAFE_QUERY_VALUE_RE.test(value) ? `${safeKey}=${value}` : `${safeKey}=…`;
      })
      .join('&');
  }

  const rendered = `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  return truncate(applySecretPatterns(rendered), MAX_URL_CHARS);
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// ─── Console formatting ───────────────────────────────────────────

/** Render one console argument. Errors keep their name/message; objects are
 *  JSON-stringified (cycles and getters degrade to a placeholder). */
function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg) ?? String(arg);
    } catch {
      return '[unserializable]';
    }
  }
  try {
    return String(arg);
  } catch {
    return '[unstringifiable]';
  }
}

/**
 * Join console arguments into one redacted, bounded message line. Pure.
 */
export function formatConsoleArgs(
  args: readonly unknown[],
  maxChars: number = MAX_CONSOLE_MESSAGE_CHARS,
): string {
  const joined = (args ?? [])
    .map(formatConsoleArg)
    .join(' ')
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .trim();
  return truncate(redactSensitiveText(joined), maxChars);
}

/**
 * Keep the first few frames of a stack trace, normalized to one line each and
 * redacted. The head of a stack is where the bug is; the tail is framework
 * noise that would blow the event budget.
 */
export function formatStack(stack: unknown, maxFrames: number = MAX_STACK_FRAMES): string {
  if (typeof stack !== 'string' || !stack.trim()) return '';
  const frames = stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxFrames + 1); // +1 because line 0 is usually "Error: message"
  return truncate(redactSensitiveText(frames.join(' | ')), MAX_CONSOLE_MESSAGE_CHARS);
}

// ─── Rate limiting ────────────────────────────────────────────────

/**
 * Token bucket bounding telemetry volume. A page stuck in an error loop can
 * emit thousands of identical console errors per second; without a cap those
 * would evict every DOM event from the recorder's rolling window and leave the
 * replay unplayable. Deterministic and injectable (`now`) so it unit tests
 * without timers.
 */
export class TelemetryRateLimiter {
  private windowStart = -Infinity;
  private windowCount = 0;
  private totalCount = 0;

  constructor(
    private readonly perWindow: number = MAX_EVENTS_PER_WINDOW,
    private readonly windowMs: number = RATE_WINDOW_MS,
    private readonly perPage: number = MAX_EVENTS_PER_PAGE,
  ) {}

  /** True when an event may be emitted at `now` (and books it). */
  allow(now: number): boolean {
    if (this.totalCount >= this.perPage) return false;
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.perWindow) return false;
    this.windowCount += 1;
    this.totalCount += 1;
    return true;
  }

  /** Events emitted so far this page (for tests / diagnostics). */
  get emitted(): number {
    return this.totalCount;
  }
}

// ─── Installation ─────────────────────────────────────────────────

export interface ReplayInstrumentationOptions {
  /** Receives each ready-made rrweb custom event. */
  emit: ReplayCustomEventEmitter;
  /** Console object to patch. Defaults to the global console. */
  consoleObj?: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> | null;
  /** Window-ish target for error listeners + fetch/XHR patching. Defaults to `window`. */
  win?: any;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Console levels to capture. Defaults to {@link DEFAULT_CONSOLE_LEVELS}. */
  levels?: readonly ConsoleLevel[];
  /** Disable console/error capture (network only). */
  captureConsole?: boolean;
  /** Disable fetch/XHR capture (console only). */
  captureNetwork?: boolean;
  /** Override the rate limiter (tests). */
  limiter?: TelemetryRateLimiter;
}

// ─── Shared surface installations ─────────────────────────────────
//
// Each patched surface (a console object, a window's error listeners, a
// window's fetch/XHR) is installed AT MOST ONCE and fans out to every
// subscriber attached to it. Two properties fall out of that:
//
//  - No double-wrapping. A second install doesn't stack another
//    `console.error` wrapper or register duplicate listeners.
//  - No dropped owner. Two overlapping recorders BOTH receive telemetry —
//    the second one's emitter is added to the surface's subscriber set, not
//    discarded — and the patches are only torn down when the LAST subscriber
//    detaches. Stopping recorder A no longer silences recorder B.
//
// The registry is a WeakMap rather than a marker property on the target:
// it works on frozen/exotic targets, pollutes nothing, and — unlike a
// boolean marker — carries the live subscriber set a second caller needs to
// join.

/** Receives a captured telemetry entry. One per attached owner. */
type TelemetrySink = (tag: string, payload: unknown) => void;

interface SurfaceInstall<H = unknown> {
  /** Every owner currently attached to this surface. */
  subscribers: Set<TelemetrySink>;
  /** Restores the target's originals. Runs when the last subscriber leaves. */
  teardown: () => void;
  /** Surface-specific controller a joining owner can extend (see console). */
  handle: H;
}

const SURFACE_INSTALLS = new WeakMap<object, Map<string, SurfaceInstall<any>>>();

const CONSOLE_SURFACE = 'console';
const LISTENER_SURFACE = 'listeners';
const NETWORK_SURFACE = 'network';

/**
 * Attach `sink` to a target's surface, running `install` on first attach.
 * Returns a detach function; the patches are restored when the last
 * subscriber detaches. Never throws.
 *
 * `onAttach` runs for EVERY owner — the first and every joiner — with the
 * surface's controller, so an owner whose requirements exceed what's already
 * installed can widen it (the console surface uses this to patch levels a
 * previous owner didn't ask for).
 */
function attachToSurface<H>(
  target: object,
  surface: string,
  sink: TelemetrySink,
  install: (dispatch: TelemetrySink) => { handle: H; restore: () => void },
  onAttach?: (handle: H) => void,
): () => void {
  let surfaces = SURFACE_INSTALLS.get(target);
  if (!surfaces) {
    surfaces = new Map<string, SurfaceInstall<any>>();
    SURFACE_INSTALLS.set(target, surfaces);
  }
  let record = surfaces.get(surface) as SurfaceInstall<H> | undefined;
  if (!record) {
    const subscribers = new Set<TelemetrySink>();
    const dispatch: TelemetrySink = (tag, payload) => {
      // A snapshot, so a sink that detaches mid-dispatch can't mutate the set
      // we're iterating.
      for (const subscriber of Array.from(subscribers)) {
        try {
          subscriber(tag, payload);
        } catch {
          // One failing sink must never starve the others.
        }
      }
    };
    let created: { handle: H; restore: () => void };
    try {
      created = install(dispatch);
    } catch {
      // The surface couldn't be patched (frozen target, exotic host object).
      // Report a detach that does nothing rather than half-registering.
      return () => {};
    }
    const entry: SurfaceInstall<H> = {
      subscribers,
      handle: created.handle,
      teardown: () => {
        try {
          created.restore();
        } catch {
          // ignore — teardown is best-effort
        }
        surfaces!.delete(surface);
      },
    };
    surfaces.set(surface, entry);
    record = entry;
  }
  const attached = record;
  try {
    onAttach?.(attached.handle);
  } catch {
    // Widening is best-effort; a failure must not abort the attach.
  }
  attached.subscribers.add(sink);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    attached.subscribers.delete(sink);
    if (attached.subscribers.size === 0) attached.teardown();
  };
}

/**
 * Controller for a shared console surface: patches levels on demand so the
 * installed set is the UNION of what every attached owner asked for.
 *
 * Without this, the first owner's `levels` froze the surface — an `error`-only
 * owner followed by a `warn`-only owner meant `console.warn` was never patched
 * and the second owner captured nothing. Each level is patched at most once,
 * regardless of how many owners request it.
 */
interface ConsoleSurfaceHandle {
  ensureLevels(levels: readonly ConsoleLevel[]): void;
}

function installConsolePatches(
  target: any,
  dispatch: TelemetrySink,
): { handle: ConsoleSurfaceHandle; restore: () => void } {
  const restores = new Map<ConsoleLevel, () => void>();

  const ensureLevels = (levels: readonly ConsoleLevel[]) => {
    for (const level of levels) {
      if (restores.has(level)) continue;
      const original = target[level];
      if (typeof original !== 'function') continue;
      const patched = function (this: unknown, ...args: unknown[]) {
        try {
          const errArg = args.find((a) => a instanceof Error) as Error | undefined;
          const payload: ReplayConsolePayload = {
            level,
            message: formatConsoleArgs(args),
          };
          const stack = errArg ? formatStack(errArg.stack) : '';
          if (stack) payload.stack = stack;
          dispatch(REPLAY_CONSOLE_TAG, payload);
        } catch {
          // ignore — capture must never break a console call
        }
        return original.apply(this, args as []);
      };
      target[level] = patched;
      restores.set(level, () => {
        // Only restore if nothing else re-patched on top of us.
        if (target[level] === patched) target[level] = original;
      });
    }
  };

  return {
    handle: { ensureLevels },
    restore: () => {
      for (const restore of Array.from(restores.values()).reverse()) {
        try {
          restore();
        } catch {
          // ignore
        }
      }
      restores.clear();
    },
  };
}

/** Register uncaught-error / unhandled-rejection listeners. */
function installErrorListeners(
  win: any,
  dispatch: TelemetrySink,
): { handle: null; restore: () => void } {
  const onError = (e: any) => {
    const message = formatConsoleArgs([
      e?.message || e?.error?.message || 'Uncaught error',
      e?.filename ? `(${e.filename}:${e.lineno ?? '?'}:${e.colno ?? '?'})` : '',
    ]);
    const payload: ReplayConsolePayload = { level: 'exception', message };
    const stack = formatStack(e?.error?.stack);
    if (stack) payload.stack = stack;
    dispatch(REPLAY_CONSOLE_TAG, payload);
  };
  const onRejection = (e: any) => {
    const reason = e?.reason;
    const payload: ReplayConsolePayload = {
      level: 'unhandledrejection',
      message: formatConsoleArgs([reason ?? 'Unhandled promise rejection']),
    };
    const stack = formatStack(reason?.stack);
    if (stack) payload.stack = stack;
    dispatch(REPLAY_CONSOLE_TAG, payload);
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return {
    handle: null,
    restore: () => {
      try {
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRejection);
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Patch `fetch` and `XMLHttpRequest`.
 *
 * `now` comes from the owner that installed the surface — request durations
 * are measured on that clock even when a later owner attaches with its own.
 * Durations are relative spans, so this only matters to tests that inject a
 * fake clock.
 */
function installNetworkPatches(
  win: any,
  now: () => number,
  dispatch: TelemetrySink,
): { handle: null; restore: () => void } {
  const baseHref = safeBaseHref(win);
  const restores: Array<() => void> = [];

  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    const patchedFetch = function (this: unknown, input: any, init?: any) {
      const started = now();
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      const rawUrl = typeof input === 'string' ? input : (input?.url ?? String(input ?? ''));
      let result: any;
      try {
        result = originalFetch.apply(this, arguments as unknown as []);
      } catch (err) {
        // Synchronous throw (bad input) — record and rethrow untouched.
        dispatch(REPLAY_NETWORK_TAG, {
          kind: 'fetch',
          method,
          url: redactUrlForReplay(rawUrl, baseHref),
          status: 0,
          durationMs: Math.max(0, now() - started),
          error: truncate(redactSensitiveText(errorMessage(err)), 200),
        } satisfies ReplayNetworkPayload);
        throw err;
      }
      if (!result || typeof result.then !== 'function') return result;
      return result.then(
        (res: any) => {
          dispatch(REPLAY_NETWORK_TAG, {
            kind: 'fetch',
            method,
            url: redactUrlForReplay(res?.url || rawUrl, baseHref),
            status: Number(res?.status ?? 0) || 0,
            durationMs: Math.max(0, now() - started),
          } satisfies ReplayNetworkPayload);
          return res;
        },
        (err: any) => {
          dispatch(REPLAY_NETWORK_TAG, {
            kind: 'fetch',
            method,
            url: redactUrlForReplay(rawUrl, baseHref),
            status: 0,
            durationMs: Math.max(0, now() - started),
            error: truncate(redactSensitiveText(errorMessage(err)), 200),
          } satisfies ReplayNetworkPayload);
          throw err;
        },
      );
    };
    win.fetch = patchedFetch;
    restores.push(() => {
      if (win.fetch === patchedFetch) win.fetch = originalFetch;
    });
  }

  const XHR = win.XMLHttpRequest;
  if (typeof XHR === 'function' && XHR.prototype) {
    const proto = XHR.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (this: any, method: any, url: any, ...rest: unknown[]) {
      try {
        this.__agentHubReplay = { method: String(method ?? 'GET').toUpperCase(), url };
      } catch {
        // ignore — a frozen XHR instance just loses its capture
      }
      return originalOpen.apply(this, [method, url, ...rest] as unknown as []);
    };
    proto.send = function (this: any, ...args: unknown[]) {
      try {
        const meta = this.__agentHubReplay;
        if (meta) {
          meta.started = now();
          const finish = () => {
            if (meta.done) return;
            meta.done = true;
            dispatch(REPLAY_NETWORK_TAG, {
              kind: 'xhr',
              method: meta.method,
              url: redactUrlForReplay(meta.url, baseHref),
              status: Number(this.status ?? 0) || 0,
              durationMs: Math.max(0, now() - meta.started),
              ...(this.status ? {} : { error: 'network error' }),
            } satisfies ReplayNetworkPayload);
          };
          this.addEventListener?.('loadend', finish);
        }
      } catch {
        // ignore — capture must never break the request
      }
      return originalSend.apply(this, args as []);
    };
    restores.push(() => {
      if (proto.open !== originalOpen) proto.open = originalOpen;
      if (proto.send !== originalSend) proto.send = originalSend;
    });
  }

  return {
    handle: null,
    restore: () => {
      for (const restore of restores.splice(0).reverse()) {
        try {
          restore();
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * Patch console, global error handlers, `fetch`, and `XMLHttpRequest` so each
 * one emits an rrweb custom event, and return an uninstall function that
 * detaches this caller.
 *
 * Contract: **never throws and never breaks the host app.** Every patched path
 * calls the original first (or in a `finally`), and every capture step is
 * wrapped — a bug in redaction must not turn into a broken `fetch` for the
 * customer.
 *
 * **Shared per surface, not first-come-first-served.** Each target surface is
 * patched once and fans out to every attached caller, so two overlapping
 * recorders both receive telemetry and neither double-wraps the other's
 * patches. The uninstall returned here detaches only THIS caller; the patches
 * come off when the last one leaves. Rate limiting is per-caller, so one
 * owner's flood can't starve another's budget.
 *
 * **Per-caller `levels` are honored on the shared surface**, in both
 * directions: attaching widens the console surface to the union of every
 * owner's requested levels (so a later `warn`-only owner isn't stuck with an
 * earlier owner's `error`-only patch set), and each owner's sink filters back
 * down to its own levels (so widening for one owner doesn't start delivering
 * `warn` to an owner that asked for `error` only). Filtering happens before the
 * rate limiter, so unwanted levels don't consume budget.
 */
export function installReplayInstrumentation(opts: ReplayInstrumentationOptions): () => void {
  const emit = opts.emit;
  const now = opts.now ?? (() => Date.now());
  const win: any = opts.win ?? (typeof window !== 'undefined' ? window : null);
  const target: any =
    opts.consoleObj ?? (typeof console !== 'undefined' ? (console as unknown as any) : null);
  const levels = opts.levels ?? DEFAULT_CONSOLE_LEVELS;
  const limiter = opts.limiter ?? new TelemetryRateLimiter();
  const captureConsole = opts.captureConsole !== false;
  const captureNetwork = opts.captureNetwork !== false;

  /** This caller's sink: its own clock, its own rate budget, its own emitter. */
  const sink: TelemetrySink = (tag, payload) => {
    try {
      const ts = now();
      if (!limiter.allow(ts)) return;
      emit({ type: RRWEB_CUSTOM_EVENT_TYPE, timestamp: ts, data: { tag, payload } });
    } catch {
      // Telemetry is strictly additive — never let it surface to the app.
    }
  };

  /**
   * Console entries pass through this caller's own level filter first.
   * The shared surface may be patching levels a DIFFERENT owner asked for;
   * those events reach every subscriber, and this is what keeps them out of an
   * owner that never requested them. `exception` / `unhandledrejection` are not
   * console methods — they come from the listener surface and always pass.
   */
  const wantedLevels = new Set<string>(levels);
  const consoleSink: TelemetrySink = (tag, payload) => {
    if (tag === REPLAY_CONSOLE_TAG) {
      const level = (payload as ReplayConsolePayload | undefined)?.level;
      if (level && !wantedLevels.has(level)) return;
    }
    sink(tag, payload);
  };

  const detachers: Array<() => void> = [];

  if (captureConsole && target) {
    detachers.push(
      attachToSurface<ConsoleSurfaceHandle>(
        target,
        CONSOLE_SURFACE,
        consoleSink,
        (dispatch) => installConsolePatches(target, dispatch),
        // Widen the shared surface to cover this owner's levels, whether we
        // created it or joined one a previous owner installed.
        (handle) => handle.ensureLevels(levels),
      ),
    );
  }

  if (captureConsole && win && typeof win.addEventListener === 'function') {
    detachers.push(
      attachToSurface<null>(win, LISTENER_SURFACE, sink, (dispatch) =>
        installErrorListeners(win, dispatch),
      ),
    );
  }

  if (captureNetwork && win) {
    detachers.push(
      attachToSurface<null>(win, NETWORK_SURFACE, sink, (dispatch) =>
        installNetworkPatches(win, now, dispatch),
      ),
    );
  }

  return () => {
    for (const detach of detachers.splice(0).reverse()) {
      try {
        detach();
      } catch {
        // ignore — teardown is best-effort
      }
    }
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/** Best-effort page URL used as the base for resolving relative request URLs. */
function safeBaseHref(win: any): string | undefined {
  try {
    const href = win?.location?.href;
    return typeof href === 'string' && href ? href : undefined;
  } catch {
    return undefined;
  }
}

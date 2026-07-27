/**
 * Runtime engine failover — switch to another authenticated CLI when the
 * engine a run is *already using* dies on usage exhaustion, an auth failure,
 * or repeated upstream API errors.
 *
 * How this differs from `engine-resolver.ts`:
 *
 *   - `engine-resolver` is a **pre-flight** check. It asks "is the preferred
 *     engine installed + authenticated for this user?" and picks another one
 *     before anything spawns. It cannot see a run that starts fine and then
 *     hits "5-hour limit reached" ten minutes in.
 *   - This module is the **post-flight** half. It classifies the error text a
 *     dead run left behind and decides whether another engine could plausibly
 *     do better, then names the next candidate from a per-engine chain.
 *
 * Both halves share `failoverChainFor()` so the pre-flight and runtime paths
 * can never disagree about the priority order.
 *
 * Why classification matters: retrying "prompt is too long" on a different
 * engine fails identically and burns a second quota; retrying "429 overloaded"
 * on the SAME engine usually works (that is `turn-error.ts`'s bounded retry)
 * and only deserves an engine switch once those retries are spent. Only two
 * classes justify an immediate switch — the engine is out of budget, or the
 * engine cannot authenticate. Everything else either retries in place or
 * stops.
 *
 * Deliberately conservative: an unrecognized failure (e.g. a bare
 * `claude-code exited with code 1`, which is usually a bug in the run itself,
 * not the provider) does NOT fail over. Failing over on every error would walk
 * a deterministic failure through all four engines, quadrupling cost and
 * latency to reach the same dead end.
 */

import {
  ALL_SUPPORTED_ENGINES,
  RAG_ONLY_ENGINES,
  type EngineAvailability,
  type SupportedEngine,
} from './engine-availability.js';
import { isTransientTurnError, TRANSIENT_TURN_ERROR_MAX_RETRIES } from './turn-error.js';

/**
 * Per-engine failover priority. Each chain starts with its own engine so the
 * same list doubles as the pre-flight order in `engine-resolver.ts`.
 *
 * Ordering rationale (product decision, not a technical constraint): the two
 * frontier coding engines back each other up first (Claude ↔ Codex), Grok
 * takes third as the independent-provider hedge — a Claude outage and an
 * OpenAI outage are correlated far less often with xAI than with each other —
 * and Cursor is last everywhere because it proxies the same upstream models,
 * so it is the least likely to be healthy when the primary is not.
 *
 * `gemini-cli` appears in no chain: it is RAG/embeddings-only (see
 * `RAG_ONLY_ENGINES`) and its interactive free tier hard-429s.
 */
export const ENGINE_FAILOVER_CHAINS: Readonly<Record<string, readonly SupportedEngine[]>> = {
  'claude-code': ['claude-code', 'codex-cli', 'grok-cli', 'cursor-agent'],
  'codex-cli': ['codex-cli', 'claude-code', 'grok-cli', 'cursor-agent'],
  'grok-cli': ['grok-cli', 'claude-code', 'codex-cli', 'cursor-agent'],
  'cursor-agent': ['cursor-agent', 'claude-code', 'codex-cli', 'grok-cli'],
} as const;

/**
 * Order used when the current engine has no chain of its own (unknown engine
 * id, or a RAG-only engine that leaked into a row). Mirrors the Claude-first
 * chain since Claude Code is the historical default for these surfaces.
 */
export const DEFAULT_ENGINE_FAILOVER_CHAIN: readonly SupportedEngine[] =
  ENGINE_FAILOVER_CHAINS['claude-code'];

/**
 * Ordered failover candidates for `engine`, always starting with `engine`
 * itself when it is a selectable agent engine. RAG-only engines are stripped
 * so no caller can select one by accident.
 */
export function failoverChainFor(engine: string | null | undefined): readonly SupportedEngine[] {
  const key = typeof engine === 'string' ? engine.trim() : '';
  const chain = ENGINE_FAILOVER_CHAINS[key] ?? DEFAULT_ENGINE_FAILOVER_CHAIN;
  return chain.filter((e) => !RAG_ONLY_ENGINES.has(e));
}

/**
 * What kind of failure ended the run.
 *
 * - `usage-exhausted`: quota / rate plan / credit balance is spent. Another
 *   engine has its own quota, so switch immediately — retrying here cannot
 *   succeed until the window resets (hours, typically).
 * - `engine-auth`: this engine's credentials are missing, invalid, or
 *   rejected. Switch immediately; a different engine has different creds.
 * - `transient`: socket drop, 5xx, overload, timeout. Retry the SAME engine
 *   first (`turn-error.ts`); only switch once that budget is spent.
 * - `permanent`: would fail identically anywhere (context overflow, content
 *   policy) or is an intentional engine limit (max turns). Never switch.
 * - `unknown`: unrecognized. Treated as non-failoverable on purpose.
 */
export type EngineFailureKind =
  | 'usage-exhausted'
  | 'engine-auth'
  | 'transient'
  | 'permanent'
  | 'unknown';

/**
 * Checked FIRST so a message that mentions both a limit and a context
 * overflow is not laundered into a pointless failover.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /max.?turns/i,
  /prompt is too long|context (length|window)|input is too long|too many tokens/i,
  /content.?(policy|filter)/i,
  /\b(400|404|413|422)\b/,
];

/**
 * Usage / quota exhaustion across the four CLIs. These strings come from what
 * the providers actually emit through the CLI stream — Anthropic's rolling
 * window notice, OpenAI's plan limits, xAI/Cursor credit messages, and the
 * `limit: 0` shape Google returns for a zeroed free tier.
 */
const USAGE_EXHAUSTED_PATTERNS: RegExp[] = [
  /usage limit/i,
  /\b\d+\s*-?\s*hour limit (reached|exceeded)/i,
  /limit (reached|exceeded).*\bresets?\b/i,
  /quota (exceeded|exhausted)|exhausted your .*quota|out of quota/i,
  /\blimit:\s*0\b/,
  /credit balance/i,
  /billing/i,
  /insufficient (credits?|quota|balance|funds)/i,
  /out of (credits?|tokens)/i,
  /(monthly|daily|weekly) limit/i,
  /plan limit|upgrade (your plan|to a paid)/i,
  /you'?ve (reached|hit) your/i,
];

/**
 * Auth failures. `401`/`403` are included as bare status codes because the
 * CLIs frequently surface nothing but the code.
 *
 * Deliberately omits a bare `permission denied`: that string is far more
 * often a filesystem `EACCES` from a tool call inside the run than a provider
 * auth rejection, and switching engines cannot fix a chmod problem.
 */
const ENGINE_AUTH_PATTERNS: RegExp[] = [
  /invalid (x-)?api.?key/i,
  /authentication(_error)?|unauthorized|forbidden/i,
  /\b(401|403)\b/,
  /not (logged in|authenticated)|login required|please (run )?.*login/i,
  /(api.?key|credential|token).*(missing|not (set|found)|expired|revoked)/i,
];

/**
 * Transient shapes `turn-error.ts` does not cover. Its patterns match
 * "request timed out" / "timeout" but not our own harness wording ("Timed out
 * after 15 minutes"), which is how a wedged provider surfaces on the one-shot
 * path — the CLI never returns and we kill it. A stall is a transient
 * provider failure, not a reason to give up on the work.
 */
const EXTRA_TRANSIENT_PATTERNS: RegExp[] = [/timed ?out/i];

/**
 * Classify the error text a dead run left behind. Never throws; unrecognized
 * input returns `unknown` (which does not fail over).
 */
export function classifyEngineFailure(errorText: string | null | undefined): EngineFailureKind {
  const text = typeof errorText === 'string' ? errorText.trim() : '';
  if (!text) return 'unknown';
  if (PERMANENT_PATTERNS.some((p) => p.test(text))) return 'permanent';
  if (USAGE_EXHAUSTED_PATTERNS.some((p) => p.test(text))) return 'usage-exhausted';
  if (ENGINE_AUTH_PATTERNS.some((p) => p.test(text))) return 'engine-auth';
  if (isTransientTurnError(text) || EXTRA_TRANSIENT_PATTERNS.some((p) => p.test(text))) {
    return 'transient';
  }
  return 'unknown';
}

/** Why a failover fired — carried into the user-facing notice. */
export type FailoverTrigger = 'usage-exhausted' | 'engine-auth' | 'transient-exhausted';

export interface EngineFailoverPlanInput {
  /** Error text from the dead run (stream error preferred over exit code). */
  errorText: string;
  /** Engine the dead run used. */
  currentEngine: string;
  /**
   * Same-engine transient retries already performed for this turn chain.
   * A `transient` failure only fails over once this reaches
   * `TRANSIENT_TURN_ERROR_MAX_RETRIES`.
   */
  transientRetries?: number;
  /**
   * Engines already failed over FROM earlier in this chain. Prevents a
   * ping-pong loop (A → B → A) and bounds the walk to one pass.
   */
  triedEngines?: readonly string[];
  /** Availability map from `probeAllEngineAvailability`. */
  availability: Record<SupportedEngine, EngineAvailability>;
}

export type EngineFailoverPlan =
  | {
      failover: true;
      trigger: FailoverTrigger;
      fromEngine: string;
      toEngine: SupportedEngine;
      /** `triedEngines` plus `fromEngine` — pass to the next attempt. */
      tried: string[];
    }
  | {
      failover: false;
      /**
       * - `not-failoverable`: the failure kind does not justify a switch.
       * - `retry-first`: transient, but the same-engine retry budget remains.
       * - `no-engine-available`: a switch was warranted but every candidate
       *   in the chain is unavailable or already tried.
       */
      reason: 'not-failoverable' | 'retry-first' | 'no-engine-available';
      kind: EngineFailureKind;
      /** Set when `reason` is `no-engine-available`. */
      trigger?: FailoverTrigger;
    };

/**
 * Decide whether to switch engines and to which one. Pure: callers supply the
 * availability map so this never touches the filesystem.
 */
export function planEngineFailover(input: EngineFailoverPlanInput): EngineFailoverPlan {
  const kind = classifyEngineFailure(input.errorText);
  const retries = input.transientRetries ?? 0;

  let trigger: FailoverTrigger;
  if (kind === 'usage-exhausted') trigger = 'usage-exhausted';
  else if (kind === 'engine-auth') trigger = 'engine-auth';
  else if (kind === 'transient') {
    // Same-engine retry is cheaper and usually sufficient for a blip; only
    // give up on this engine once `turn-error.ts` has spent its budget.
    if (retries < TRANSIENT_TURN_ERROR_MAX_RETRIES) {
      return { failover: false, reason: 'retry-first', kind };
    }
    trigger = 'transient-exhausted';
  } else {
    return { failover: false, reason: 'not-failoverable', kind };
  }

  const from = input.currentEngine?.trim() || 'claude-code';
  const tried = new Set<string>([...(input.triedEngines ?? []), from]);
  const toEngine = failoverChainFor(from).find(
    (candidate) => !tried.has(candidate) && input.availability[candidate]?.available === true,
  );

  if (!toEngine) {
    return { failover: false, reason: 'no-engine-available', kind, trigger };
  }
  return { failover: true, trigger, fromEngine: from, toEngine, tried: [...tried] };
}

/** Short human label per engine id, used in transcript notices. */
export function engineLabel(engine: string): string {
  switch (engine) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex-cli':
      return 'Codex';
    case 'cursor-agent':
      return 'Cursor Agent';
    case 'grok-cli':
      return 'Grok';
    case 'gemini-cli':
      return 'Gemini';
    default:
      return engine;
  }
}

function triggerPhrase(trigger: FailoverTrigger): string {
  switch (trigger) {
    case 'usage-exhausted':
      return 'ran out of usage quota';
    case 'engine-auth':
      return 'could not authenticate';
    case 'transient-exhausted':
      return `kept failing with API errors after ${TRANSIENT_TURN_ERROR_MAX_RETRIES} retries`;
  }
}

export interface EngineFailoverNoticeInput {
  trigger: FailoverTrigger;
  fromEngine: string;
  fromModel?: string | null;
  toEngine: string;
  toModel?: string | null;
  errorText: string;
}

function modelSuffix(model: string | null | undefined): string {
  const m = model?.trim();
  return m ? ` (\`${m}\`)` : '';
}

/**
 * Transcript warning shown when a run switches engines. Names what failed,
 * why, and exactly what is running now — the user did not ask for this
 * switch, so the message has to make the substitution obvious rather than
 * letting a different model silently answer.
 */
export function buildEngineFailoverNotice(input: EngineFailoverNoticeInput): string {
  return (
    `**Switched to ${engineLabel(input.toEngine)}${modelSuffix(input.toModel)}** — ` +
    `${engineLabel(input.fromEngine)}${modelSuffix(input.fromModel)} ${triggerPhrase(input.trigger)}.\n\n` +
    `> ${input.errorText.trim().slice(0, 500)}\n\n` +
    `Continuing automatically on ${engineLabel(input.toEngine)}. It starts a fresh CLI ` +
    `conversation, so it does not inherit the previous engine's internal context — the ` +
    `transcript above is the shared record. Switch back from the engine picker once ` +
    `${engineLabel(input.fromEngine)} is available again.`
  );
}

/**
 * Transcript warning when a switch was warranted but nothing else is
 * available. Distinguishes "we gave up" from "we never tried".
 */
export function buildNoFailoverEngineNotice(
  trigger: FailoverTrigger,
  fromEngine: string,
  availability: Record<SupportedEngine, EngineAvailability>,
): string {
  const chain = failoverChainFor(fromEngine).filter((e) => e !== fromEngine);
  const lines = chain.map(
    (e) => `  • ${engineLabel(e)}: ${availability[e]?.detail ?? 'unavailable'}`,
  );
  return (
    `**${engineLabel(fromEngine)} ${triggerPhrase(trigger)} and no fallback engine is available.**\n\n` +
    `Tried, in order:\n${lines.join('\n')}\n\n` +
    `Add credentials for one of these under Account settings to keep runs going when ` +
    `${engineLabel(fromEngine)} is out.`
  );
}

/** Console/log one-liner for the switch (background runs + server logs). */
export function formatFailoverLogLine(
  scope: string,
  input: EngineFailoverNoticeInput & { trigger: FailoverTrigger },
): string {
  return (
    `[engine-failover] ${scope}: ${input.fromEngine} (${input.fromModel ?? 'default'}) ` +
    `${triggerPhrase(input.trigger)} — switching to ${input.toEngine} ` +
    `(${input.toModel ?? 'default'}): ${input.errorText.trim().slice(0, 200)}`
  );
}

/** All engines that can appear in a chain — handy for tests + diagnostics. */
export const FAILOVER_ELIGIBLE_ENGINES: readonly SupportedEngine[] = ALL_SUPPORTED_ENGINES.filter(
  (e) => !RAG_ONLY_ENGINES.has(e),
);

/**
 * Skill Builder, Phase 3 — eval-driven test loop (pure core).
 *
 * A skill can carry an eval suite at `<skill>/evals/evals.json`: 2-3 realistic
 * test prompts that prove the skill actually changes behavior. This module is
 * the framework-free core that parses/validates that file and grades a model
 * output against a prompt's assertions. Spawning the with-skill vs baseline
 * runs lives in `skill-eval-runner.ts`; the REST surface in
 * `routes/skill-evals.ts`. Kept side-effect free (no fs, no express, no CLI)
 * so the rules are unit-testable in isolation.
 *
 * Two grading modes, mirroring how real skill-builders work:
 *   - **objective** — the eval lists `assertions` (substring / regex checks).
 *     We can decide pass/fail mechanically, so the coach gets a hard signal.
 *   - **subjective** — no assertions. We can't auto-grade, so the runner
 *     surfaces a side-by-side with-skill vs baseline diff for human judgement.
 */

import { Worker } from 'node:worker_threads';

export const EVAL_ASSERTION_TYPES = ['contains', 'icontains', 'not_contains', 'regex'] as const;
export type SkillEvalAssertionType = (typeof EVAL_ASSERTION_TYPES)[number];

export interface SkillEvalAssertion {
  type: SkillEvalAssertionType;
  /** Substring (contains/icontains/not_contains) or regex source (regex). */
  value: string;
}

export interface SkillEval {
  /** Stable id for the prompt — lets the coach re-run a single eval. */
  id: string;
  /** The realistic user prompt fed to both the with-skill and baseline runs. */
  prompt: string;
  /**
   * Objective checks. Omit (or leave empty) for a subjective eval that only
   * gets a side-by-side diff.
   */
  assertions?: SkillEvalAssertion[];
}

export interface SkillEvalsFile {
  /** Schema version — currently always 1. */
  version: number;
  evals: SkillEval[];
}

/** Most skills want 2-3 prompts; cap to keep an eval run from spawning a fleet. */
export const MAX_EVALS_PER_SKILL = 10;
export const MAX_ASSERTIONS_PER_EVAL = 10;
export const EVAL_PROMPT_MAX = 8000;
export const EVAL_ASSERTION_VALUE_MAX = 2000;
const EVAL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EVAL_ID_MAX = 64;

/**
 * ReDoS guard for user-authored `regex` assertions. The patterns come from
 * evals.json / the request body, so a syntactically valid but catastrophic
 * pattern (e.g. `(a+)+$`) could backtrack exponentially. Matching it in-process
 * — even inside a `vm` timeout — is not a reliable bound: the watchdog can only
 * interrupt at JS interrupt points, not necessarily mid-backtrack in V8's
 * native regexp engine. So we run the user regexes in a dedicated worker thread
 * and, if it overruns a hard budget, `terminate()` it (a forced thread kill
 * that stops native execution). Any assertion still pending at termination is
 * recorded as a failed + timed-out assertion. The event loop is never blocked
 * by a user pattern. Input is also length-capped before it crosses the thread.
 */
export const REGEX_TEST_TIMEOUT_MS = 250;
export const REGEX_INPUT_MAX = 100_000;

export type ParseEvalsResult = { ok: true; evals: SkillEval[] } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reject unknown keys so a typo (e.g. `assertion` for `assertions`, or
 * `pattern` for `value`) is a loud 400 rather than silently dropped — a dropped
 * `assertions` would quietly turn an objective eval into an ungraded subjective
 * one. Mirrors the strict top-level run-body validation in the route.
 */
function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return `${where} has unknown field "${key}" (allowed: ${allowed.join(', ')})`;
    }
  }
  return null;
}

function parseAssertion(raw: unknown, where: string): SkillEvalAssertion | { error: string } {
  if (!isPlainObject(raw)) return { error: `${where} must be an object` };
  const unknown = rejectUnknownKeys(raw, ['type', 'value'], where);
  if (unknown) return { error: unknown };
  const type = raw.type;
  if (typeof type !== 'string' || !(EVAL_ASSERTION_TYPES as readonly string[]).includes(type)) {
    return {
      error: `${where}.type must be one of: ${EVAL_ASSERTION_TYPES.join(', ')}`,
    };
  }
  const value = raw.value;
  if (typeof value !== 'string' || value.length === 0) {
    return { error: `${where}.value must be a non-empty string` };
  }
  if (value.length > EVAL_ASSERTION_VALUE_MAX) {
    return { error: `${where}.value must be <= ${EVAL_ASSERTION_VALUE_MAX} characters` };
  }
  if (type === 'regex') {
    try {
      // Compile eagerly so a broken pattern is a 400 at author time, never a
      // throw mid-grade. The flags are fixed at grade time (see gradeOutput).
      new RegExp(value);
    } catch (err) {
      return {
        error: `${where}.value is not a valid regular expression: ${(err as Error).message}`,
      };
    }
  }
  return { type: type as SkillEvalAssertionType, value };
}

/**
 * Validate a raw parsed evals payload (object with `evals`, or a bare array of
 * evals) into a normalized `SkillEval[]`. Returns a single clear error string
 * the route turns into a 400. Eval ids must be unique slugs.
 */
export function parseEvals(raw: unknown): ParseEvalsResult {
  let list: unknown;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isPlainObject(raw)) {
    // Allow the saved-file `version` alongside `evals`; reject other top-level
    // keys so a misplaced field surfaces instead of being ignored.
    const top = rejectUnknownKeys(raw, ['evals', 'version'], 'evals payload');
    if (top) return { ok: false, error: top };
    if (raw.evals === undefined) return { ok: false, error: 'missing "evals" array' };
    list = raw.evals;
  } else {
    return { ok: false, error: 'evals payload must be an object with an "evals" array' };
  }

  if (!Array.isArray(list)) return { ok: false, error: '"evals" must be an array' };
  if (list.length === 0) return { ok: false, error: '"evals" must contain at least one prompt' };
  if (list.length > MAX_EVALS_PER_SKILL) {
    return { ok: false, error: `at most ${MAX_EVALS_PER_SKILL} evals are allowed` };
  }

  const evals: SkillEval[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const where = `evals[${i}]`;
    if (!isPlainObject(item)) return { ok: false, error: `${where} must be an object` };
    const unknownEvalKey = rejectUnknownKeys(item, ['id', 'prompt', 'assertions'], where);
    if (unknownEvalKey) return { ok: false, error: unknownEvalKey };

    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) return { ok: false, error: `${where}.id is required` };
    if (id.length > EVAL_ID_MAX) {
      return { ok: false, error: `${where}.id must be <= ${EVAL_ID_MAX} characters` };
    }
    if (!EVAL_ID_RE.test(id)) {
      return {
        ok: false,
        error: `${where}.id "${id}" must be a slug: lowercase letters, digits and hyphens, starting with a letter or digit`,
      };
    }
    if (seen.has(id)) return { ok: false, error: `duplicate eval id "${id}"` };
    seen.add(id);

    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!prompt) return { ok: false, error: `${where}.prompt is required` };
    if (prompt.length > EVAL_PROMPT_MAX) {
      return { ok: false, error: `${where}.prompt must be <= ${EVAL_PROMPT_MAX} characters` };
    }

    let assertions: SkillEvalAssertion[] | undefined;
    if (item.assertions !== undefined && item.assertions !== null) {
      if (!Array.isArray(item.assertions)) {
        return { ok: false, error: `${where}.assertions must be an array` };
      }
      if (item.assertions.length > MAX_ASSERTIONS_PER_EVAL) {
        return {
          ok: false,
          error: `${where}.assertions must have <= ${MAX_ASSERTIONS_PER_EVAL} entries`,
        };
      }
      assertions = [];
      for (let j = 0; j < item.assertions.length; j++) {
        const a = parseAssertion(item.assertions[j], `${where}.assertions[${j}]`);
        if ('error' in a) return { ok: false, error: a.error };
        assertions.push(a);
      }
      if (assertions.length === 0) assertions = undefined;
    }

    evals.push(assertions ? { id, prompt, assertions } : { id, prompt });
  }

  return { ok: true, evals };
}

/** Serialize a validated eval list into the canonical evals.json text. */
export function serializeEvals(evals: SkillEval[]): string {
  const file: SkillEvalsFile = { version: 1, evals };
  return JSON.stringify(file, null, 2) + '\n';
}

export interface AssertionResult {
  assertion: SkillEvalAssertion;
  passed: boolean;
  /**
   * Set on a `regex` assertion whose match exceeded `REGEX_TEST_TIMEOUT_MS` and
   * was aborted (treated as not matched). Surfaced so the author fixes a
   * catastrophic-backtracking pattern.
   */
  timedOut?: boolean;
}

export interface GradeResult {
  /** True when the eval had assertions and could be auto-graded. */
  graded: boolean;
  /** Overall pass — every assertion passed. Meaningless when `!graded`. */
  passed: boolean;
  assertionResults: AssertionResult[];
}

function evalSubstringAssertion(output: string, a: SkillEvalAssertion): boolean {
  switch (a.type) {
    case 'contains':
      return output.includes(a.value);
    case 'icontains':
      return output.toLowerCase().includes(a.value.toLowerCase());
    case 'not_contains':
      return !output.includes(a.value);
    case 'regex':
      // Regex is evaluated off-thread (see runBoundedRegex); never here.
      return false;
  }
}

/**
 * Worker body (CommonJS, run via `{ eval: true }` so there is no separate file
 * to resolve under tsx/vitest). It tests each `{ source, input }` and posts one
 * `{ i, matched }` message per result, so the parent keeps results for patterns
 * that finished before a later catastrophic one forces a terminate.
 */
const REGEX_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
for (let i = 0; i < workerData.tests.length; i++) {
  const t = workerData.tests[i];
  let matched = false;
  try { matched = new RegExp(t.source).test(t.input); } catch (_) { matched = false; }
  parentPort.postMessage({ i, matched });
}
`;

interface BoundedRegexResult {
  matched: boolean;
  timedOut?: boolean;
}

/**
 * Evaluate user-authored regexes against `output` in a dedicated worker thread
 * that is force-terminated if it overruns the budget — so a catastrophic
 * pattern can never block the event loop. Results stream back per pattern;
 * anything unfinished at termination is reported `timedOut`. The budget scales
 * with the number of patterns so a legitimate multi-regex suite still completes.
 */
function runBoundedRegex(sources: string[], output: string): Promise<BoundedRegexResult[]> {
  const input = output.length > REGEX_INPUT_MAX ? output.slice(0, REGEX_INPUT_MAX) : output;
  const tests = sources.map((source) => ({ source, input }));
  const budgetMs = Math.max(1, sources.length) * REGEX_TEST_TIMEOUT_MS;

  return new Promise<BoundedRegexResult[]>((resolve) => {
    const results: BoundedRegexResult[] = sources.map(() => ({ matched: false, timedOut: true }));
    let worker: Worker;
    try {
      worker = new Worker(REGEX_WORKER_SRC, { eval: true, workerData: { tests } });
    } catch {
      // Could not even spawn the worker — fail closed (all not-matched).
      resolve(sources.map(() => ({ matched: false })));
      return;
    }

    let settled = false;
    let done = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(results);
    };
    const timer = setTimeout(finish, budgetMs);

    worker.on('message', (m: { i: number; matched: boolean }) => {
      results[m.i] = { matched: m.matched === true };
      if (++done === tests.length) finish();
    });
    // On a worker error, keep whatever streamed back; the rest stay timed-out.
    worker.on('error', finish);
    worker.on('exit', finish);
  });
}

/**
 * Grade a model output against an eval's assertions. A subjective eval (no
 * assertions) returns `{ graded: false, passed: false, assertionResults: [] }`
 * — the caller surfaces a diff instead of a verdict.
 *
 * Async because user-authored `regex` assertions are matched in a terminable
 * worker thread (ReDoS guard); substring assertions resolve synchronously.
 */
export async function gradeOutput(
  output: string,
  assertions?: SkillEvalAssertion[],
): Promise<GradeResult> {
  if (!assertions || assertions.length === 0) {
    return { graded: false, passed: false, assertionResults: [] };
  }

  // Substring checks resolve inline; collect regex assertions for the worker.
  const regexIndexes: number[] = [];
  const assertionResults: AssertionResult[] = assertions.map((assertion, index) => {
    if (assertion.type === 'regex') {
      regexIndexes.push(index);
      return { assertion, passed: false };
    }
    return { assertion, passed: evalSubstringAssertion(output, assertion) };
  });

  if (regexIndexes.length > 0) {
    const regexResults = await runBoundedRegex(
      regexIndexes.map((i) => assertions[i].value),
      output,
    );
    regexIndexes.forEach((index, k) => {
      const r = regexResults[k];
      assertionResults[index] = r.timedOut
        ? { assertion: assertions[index], passed: false, timedOut: true }
        : { assertion: assertions[index], passed: r.matched };
    });
  }

  return {
    graded: true,
    passed: assertionResults.every((r) => r.passed),
    assertionResults,
  };
}

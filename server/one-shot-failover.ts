/**
 * Runtime engine failover for one-shot background prompts (heartbeats, crons,
 * and any other non-interactive spawn).
 *
 * `engine-resolver.ts` already picks an authenticated engine *before* the
 * spawn. That is not enough: a heartbeat that resolves to Claude at 09:00 and
 * runs into "5-hour limit reached" at 09:01 still fails, and nobody is
 * watching a background job to switch it by hand. This wrapper closes that
 * gap — it runs the prompt, and if the engine dies on quota exhaustion, an
 * auth rejection, or an upstream API error, it re-runs the same prompt on the
 * next authenticated engine in that engine's chain.
 *
 * Unlike the interactive chat path there is no same-engine retry budget here:
 * a background one-shot has no partial output to preserve and no user waiting
 * on a stream, so a transient failure is treated as immediately switchable.
 *
 * Environment is rebuilt per attempt via the caller's `buildEnv(engine)`
 * because per-account credentials, HOME, and engine-specific env all differ
 * between CLIs — reusing the failed engine's env would spawn the new CLI
 * logged out.
 */

import {
  runOneShotPrompt,
  type OneShotDetailed,
  type RunOneShotOptions,
} from './one-shot-spawn.js';
import {
  probeAllEngineAvailability,
  type EngineAvailability,
  type SupportedEngine,
} from './engine-availability.js';
import {
  planEngineFailover,
  formatFailoverLogLine,
  type FailoverTrigger,
} from './engine-failover.js';
import { TRANSIENT_TURN_ERROR_MAX_RETRIES } from './turn-error.js';
import { resolveEffectiveModel } from './effective-model.js';
import type { AppConfig } from './types.js';

export interface OneShotFailoverRecord {
  from: SupportedEngine;
  fromModel: string;
  to: SupportedEngine;
  toModel: string;
  trigger: FailoverTrigger;
  errorText: string;
}

export interface RunOneShotWithFailoverInput extends Omit<
  RunOneShotOptions,
  'env' | 'engine' | 'model' | 'detailed'
> {
  /** Engine picked by `resolveOneShotEngine` (or the caller's own choice). */
  engine: SupportedEngine;
  model: string;
  /** Acting user whose per-account creds decide which engines can take over. */
  userId?: string | null;
  /**
   * Build the spawn env for a given engine. Called once per attempt — the
   * fallback engine needs its own credentials, not the failed engine's.
   */
  buildEnv: (engine: SupportedEngine) => NodeJS.ProcessEnv;
  /** Label used in log lines, e.g. `heartbeat "Docs agent"`. */
  scope: string;
  /**
   * Failure shape for the FINAL attempt, matching `runOneShotPrompt`'s two
   * modes so callers keep their existing semantics:
   *   - `true`  → resolve with the detailed result even on a non-zero exit
   *               (crons display partial output on failure).
   *   - `false` → throw when the run exited non-zero with no stdout
   *               (heartbeats record the run as errored).
   */
  detailed?: boolean;
}

export interface OneShotFailoverOutcome {
  /** Engine that actually produced the result. */
  engine: SupportedEngine;
  model: string;
  /** Raw detailed result of the final attempt. */
  detailed: OneShotDetailed;
  /** Same text `runOneShotPrompt` (non-detailed) would have returned. */
  output: string;
  /** Ordered switches made to get here. Empty when the first engine worked. */
  failovers: OneShotFailoverRecord[];
}

/** Seams so tests never spawn a CLI or touch the credential filesystem. */
export interface OneShotFailoverDeps {
  runOneShot?: (input: RunOneShotOptions, cfg: AppConfig) => Promise<OneShotDetailed>;
  probeAvailability?: (
    cfg: AppConfig,
    opts: { userId?: string | null },
  ) => Promise<Record<SupportedEngine, EngineAvailability>>;
}

/** Hard stop: one pass through the chain, never more. */
const MAX_ATTEMPTS = 4;

function errorTextOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

/**
 * Run a one-shot prompt, switching engines when the current one is out of
 * quota / unauthenticated / erroring.
 *
 * Resolves with the first successful attempt. When every candidate fails it
 * resolves with the LAST attempt's detailed result (preserving the historical
 * "return whatever the CLI printed" behaviour for crons) unless the failure
 * was a thrown spawn error, which is re-thrown so callers keep logging it as
 * a hard failure.
 */
export async function runOneShotPromptWithFailover(
  input: RunOneShotWithFailoverInput,
  cfg: AppConfig,
  deps: OneShotFailoverDeps = {},
): Promise<OneShotFailoverOutcome> {
  const run =
    deps.runOneShot ??
    ((i: RunOneShotOptions, c: AppConfig) =>
      runOneShotPrompt({ ...i, detailed: true }, c) as Promise<OneShotDetailed>);
  const probe = deps.probeAvailability ?? probeAllEngineAvailability;

  const {
    engine: _engine,
    model: _model,
    userId,
    buildEnv,
    scope,
    detailed: wantDetailedFailure,
    ...spawnInput
  } = input;
  let engine = _engine;
  let model = _model;
  const tried: string[] = [];
  const failovers: OneShotFailoverRecord[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let detailed: OneShotDetailed | null = null;
    let thrown: unknown = null;
    let errorText = '';

    try {
      detailed = await run({ ...spawnInput, engine, model, env: buildEnv(engine) }, cfg);
      if (detailed.code === 0 && !detailed.timedOut) {
        return {
          engine,
          model,
          detailed,
          output: detailed.stdout || detailed.stderr || '(empty response)',
          failovers,
        };
      }
      // Non-zero exit: the provider's complaint lands on stderr for every CLI
      // we support, but Claude's --print mode sometimes prints it to stdout,
      // so consider both before classifying.
      errorText = detailed.timedOut
        ? `Timed out after ${Math.round(spawnInput.timeoutMs / 60000)} minutes`
        : detailed.stderr || detailed.stdout || `Exited with code ${detailed.code}`;
    } catch (err: unknown) {
      thrown = err;
      errorText = errorTextOf(err);
    }

    const availability = await probe(cfg, { userId: userId ?? null });
    const plan = planEngineFailover({
      errorText,
      currentEngine: engine,
      // Background one-shots have no in-place retry loop, so the same-engine
      // budget is spent by definition — a transient failure switches now
      // rather than dying with nothing to show for it.
      transientRetries: TRANSIENT_TURN_ERROR_MAX_RETRIES,
      triedEngines: tried,
      availability,
    });

    if (!plan.failover) {
      // Nothing better to try: surface exactly what the legacy path would.
      if (thrown) throw thrown;
      const final = detailed as OneShotDetailed;
      if (!wantDetailedFailure && !final.stdout) {
        // `runOneShotPrompt`'s non-detailed mode rejects here, and heartbeats
        // rely on that to log the run as errored rather than as an answer.
        const err = new Error(final.stderr || `Exited with code ${final.code}`);
        (err as Error & { engine?: string }).engine = engine;
        throw err;
      }
      return {
        engine,
        model,
        detailed: final,
        output: final.stdout || final.stderr || '(empty response)',
        failovers,
      };
    }

    const toModel = resolveEffectiveModel(cfg, plan.toEngine, { ownerUserId: userId ?? null });
    console.warn(
      formatFailoverLogLine(scope, {
        trigger: plan.trigger,
        fromEngine: engine,
        fromModel: model,
        toEngine: plan.toEngine,
        toModel,
        errorText,
      }),
    );
    failovers.push({
      from: engine,
      fromModel: model,
      to: plan.toEngine,
      toModel,
      trigger: plan.trigger,
      errorText: errorText.slice(0, 500),
    });
    tried.splice(0, tried.length, ...plan.tried);
    engine = plan.toEngine;
    model = toModel;
  }

  // Chain exhausted without a clean run — the loop only lands here when every
  // engine failed AND each failure was failover-worthy.
  throw new Error(
    `${scope}: every engine in the failover chain failed. Last error: ` +
      (failovers[failovers.length - 1]?.errorText ?? 'unknown'),
  );
}

/**
 * One-line summary of the switches, for appending to a heartbeat/cron log so
 * the user can see the run did not use the engine they configured.
 */
export function formatFailoverSummary(failovers: readonly OneShotFailoverRecord[]): string {
  if (failovers.length === 0) return '';
  const last = failovers[failovers.length - 1];
  const hops = failovers.map((f) => `${f.from} → ${f.to}`).join(', ');
  return (
    `\n\n---\n_Engine failover: ${hops}. ` +
    `${last.from} failed (${last.trigger}): ${last.errorText.slice(0, 200)}. ` +
    `This run completed on ${last.to} (${last.toModel})._`
  );
}

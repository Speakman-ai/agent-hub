/**
 * deploy-runner-loss.ts — tell "the runner died under this deploy step" apart
 * from "this deploy step failed", and bound how often we re-acquire because of
 * it.
 *
 * {@link ../deploy-acquire-retry} covers the window BEFORE any step runs: the
 * fleet had no capacity, or an agent claimed the job and died during bring-up.
 * This module covers the window after that. Once a step is in flight, the
 * runner-agent can still disappear — process crash, OOM kill, lost contact with
 * the Hub, or an EC2 Spot reclaim. The Hub-side reaper (or the agent's own error
 * report) then calls `RunnerJobChannel.fail()`, which fires `error` on the
 * spawned step, and the deploy orchestrator historically read that as a normal
 * step failure: the whole deployment terminalized `error` and an operator had to
 * re-trigger it by hand.
 *
 * That classification is wrong. The step never reported an outcome; the machine
 * running it went away. Finalize already treats this as infra and re-runs on a
 * fresh agent (`step-runner.ts` → `spot_reclaimed` / `container_unavailable`).
 * These helpers give the deploy path the same distinction.
 *
 * Two independent signals, because neither alone is complete:
 *
 *   - The **queue-row probe** (`RunnerJobLossProbe`, wired onto the spawned step
 *     by the remote backend) is authoritative: it reads the job's persisted
 *     state, lease deadline, and Spot-interruption stamp.
 *   - The **failure message** is the fallback for when the row is already gone
 *     or no probe is attached. The canonical strings are minted in exactly two
 *     places (`runner-fleet-scaler.ts`'s lease reaper and the agent error-report
 *     route), so matching them is narrow rather than a general string sniff.
 *
 * What is deliberately NOT loss: a step that exited with a real code. If the
 * runner was healthy enough to report an exit status, the deploy command itself
 * failed, and re-running it would just fail again (or, worse, half-apply a
 * deploy twice). Only an outcome with no reported exit — a spawn error, or probe
 * evidence — can classify here.
 */
import type { RunnerJobLossProbe } from '../finalize/runner-queue.js';
import { detailIsSpotReclaim } from '../finalize/spot-interruption.js';

/**
 * Why the runner went away. Mirrors the evidence, not a guess: `lease_expired`
 * means the heartbeat stopped and the reaper claimed the lease back, which can
 * be a crash OR a briefly-unreachable Hub, so we do not upgrade it to
 * `spot_reclaimed` without the interruption stamp.
 */
export type DeployRunnerLossKind = 'spot_reclaimed' | 'lease_expired' | 'agent_lost';

export interface DeployRunnerLoss {
  kind: DeployRunnerLossKind;
  /** Human-readable cause, for the step error and the ops log line. */
  detail: string;
}

/**
 * Canonical loss text minted by `runner-fleet-scaler.ts` (lease reaper) and
 * `runner-routes.ts` (agent-reported job error). Both spell it "runner agent
 * lost"; the hyphenated form comes from the acquire path. Kept as anchored-ish
 * phrases rather than loose keywords so an ordinary deploy script that happens
 * to print the word "lost" is never mistaken for infra.
 */
const AGENT_LOST_PATTERN = /runner[- ]agent lost/i;
const LEASE_EXPIRED_PATTERN = /lease (?:expired|lost)/i;

/**
 * Total re-acquires allowed for ONE deployment across all of its steps. Two by
 * default: enough to ride out a Spot reclaim followed by an unlucky second one,
 * short enough that a fleet which is genuinely broken fails the deploy instead
 * of grinding through the whole timeout budget. Env-overridable for ops tuning
 * and read at call time so a test can tune it without re-importing.
 */
export const DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES = 2;

/** Resolve the configured mid-run loss retry budget (>= 0; 0 disables). */
export function resolveDeployRunnerLossRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEPLOY_RUNNER_LOSS_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_DEPLOY_RUNNER_LOSS_RETRIES;
  return Math.max(0, n);
}

/** The subset of a step outcome that carries loss evidence. */
export interface DeployStepLossInput {
  /** The step's reported exit code; -1 when it never reported one. */
  exitCode: number;
  /** Set when the spawned step emitted `error` instead of a clean close. */
  spawnError?: string;
  /** Queue-row evidence for the job backing this step, when the backend wires one. */
  lossProbe?: RunnerJobLossProbe | null;
}

/**
 * Classify a failed step outcome as runner loss, or `null` when it is a genuine
 * deploy failure.
 *
 * Probe evidence wins over the message: the row knows about a Spot stamp the
 * reaper's generic text does not carry. Spot is checked first because the
 * reclaim message also contains "runner agent lost", and the more specific
 * classification earns the clearer operator-facing error.
 */
export function classifyDeployRunnerLoss(input: DeployStepLossInput): DeployRunnerLoss | null {
  // A reported exit status proves the runner was alive at the end of the step,
  // so whatever failed, it was the deploy command. Never retry that.
  if (input.exitCode >= 0) return null;

  const probe = input.lossProbe ?? null;
  const message = input.spawnError?.trim() || '';
  const detailFor = (fallback: string): string => probe?.detail?.trim() || message || fallback;

  if (probe?.spotInterrupted) {
    return {
      kind: 'spot_reclaimed',
      detail: detailFor('runner instance was reclaimed by an EC2 Spot interruption'),
    };
  }
  if (probe?.lost) {
    return { kind: 'agent_lost', detail: detailFor(`runner job is ${probe.state}`) };
  }
  if (probe?.leaseExpired) {
    return {
      kind: 'lease_expired',
      detail: detailFor('runner lease expired with no heartbeat'),
    };
  }

  if (!message) return null;
  if (detailIsSpotReclaim(message)) return { kind: 'spot_reclaimed', detail: message };
  if (AGENT_LOST_PATTERN.test(message)) return { kind: 'agent_lost', detail: message };
  if (LEASE_EXPIRED_PATTERN.test(message)) return { kind: 'lease_expired', detail: message };
  return null;
}

/** One-line operator-facing summary of a loss, used in the step error column. */
export function describeDeployRunnerLoss(loss: DeployRunnerLoss, retries: number): string {
  const attempts = retries === 1 ? '1 retry' : `${retries} retries`;
  const budget =
    retries > 0 ? ` after ${attempts} on a fresh runner` : ' and no retry budget remained';
  return `runner lost mid-step (${loss.kind})${budget}: ${loss.detail}`;
}

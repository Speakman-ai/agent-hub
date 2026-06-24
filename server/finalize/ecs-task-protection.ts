/**
 * ecs-task-protection.ts — keep a runner-agent's ECS task alive while it owns a job.
 *
 * The fleet runs one job per ECS task. A rolling deployment of the agent service
 * (a new task-def revision) or a capacity scale-in would otherwise SIGKILL a task
 * mid-job — the agent dies, its queue lease eventually expires, the reaper marks
 * the shard `lost`, and the waiting Finalize session hangs (the in-process channel
 * never gets a step result). Continuous deploys defeat even the retry path, since
 * each fresh retry agent is killed by the next deploy too.
 *
 * ECS *task scale-in protection* fixes this at the source: a task that marks itself
 * `ProtectionEnabled` is NOT torn down by a deployment OR a scale-in until the flag
 * clears or its (bounded) expiry lapses. The agent protects on job start, refreshes
 * on each heartbeat, and clears on job end — so an IDLE task stays freely replaceable
 * (deploys + scale-to-zero proceed) while a BUSY one is shielded.
 *
 * Self-protection goes through the ECS container-agent endpoint at `$ECS_AGENT_URI`
 * (injected into every task, with built-in retries) — no AWS SDK in this bundle.
 * Requires `ecs:UpdateTaskProtection` on the task role and container agent >= 1.65,
 * plus `deployment_maximum_percent > 100` on the service so a new deployment can roll
 * while old protected tasks drain. Outside ECS (`$ECS_AGENT_URI` unset — the local 2a
 * fleet, unit tests) every call is a no-op, so non-ECS paths are unaffected.
 *
 * Docs: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection-endpoint.html
 */

export interface TaskProtection {
  /** Mark this task protected (true) or releasable (false). Best-effort. */
  set(enabled: boolean): Promise<void>;
}

/** No-op protection for non-ECS hosts (the local same-host fleet, tests). */
export function noopTaskProtection(): TaskProtection {
  return { async set() {} };
}

/**
 * Expiry for a protection lease. A job rarely runs this long, and the agent
 * re-arms it on every heartbeat so a live job never lapses. Kept short so a truly
 * dead agent's task becomes terminable again quickly (the lease reaper's partner)
 * and well under any deploy / CloudFormation timeout.
 *
 * BUT: the re-arm only holds if the agent keeps heartbeating. A long, CPU-heavy
 * shard can starve the agent's 30s refresh loop (or the best-effort protection
 * PUT to the ECS agent endpoint can fail under load) — so the lease must cover the
 * WHOLE shard in a single arming, not just the gap between refreshes. Whenever the
 * fleet trims idle agents mid-run (FINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1), a shard
 * whose protection has lapsed is the one ECS scale-in terminates — and the longest
 * shards are the ones in flight when a shrink fires. Set
 * FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES above the longest expected shard so even
 * a refresh-starved long shard stays shielded for its full duration.
 */
export const DEFAULT_PROTECTION_EXPIRY_MINUTES = 15;

/** ECS UpdateTaskProtection caps expiresInMinutes at 2880 (48h); above that the
 * API call fails at runtime, so every resolved value is clamped to this. */
export const MAX_PROTECTION_EXPIRY_MINUTES = 2880;

/**
 * Live-resolved protection lease length (minutes). Reads
 * FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES at call time so the agent fleet can be
 * tuned via task-def env without a code change; falls back to
 * {@link DEFAULT_PROTECTION_EXPIRY_MINUTES}. Sub-1 / non-finite values are coerced
 * to the default (never arm a zero/garbage lease that lapses instantly); values
 * above {@link MAX_PROTECTION_EXPIRY_MINUTES} are clamped so the ECS call can't
 * fail at runtime even if the env is set directly (bypassing the TF bound).
 */
export function resolveProtectionExpiryMinutes(): number {
  const raw = process.env.FINALIZE_TASK_PROTECTION_EXPIRY_MINUTES?.trim();
  if (!raw) return DEFAULT_PROTECTION_EXPIRY_MINUTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PROTECTION_EXPIRY_MINUTES;
  return Math.min(n, MAX_PROTECTION_EXPIRY_MINUTES);
}

interface EcsTaskProtectionOpts {
  agentUri?: string;
  expiresInMinutes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Real protection via the ECS container-agent task-protection endpoint. Returns a
 * no-op when `$ECS_AGENT_URI` is absent (i.e. not running under ECS).
 */
export function ecsTaskProtection(opts: EcsTaskProtectionOpts = {}): TaskProtection {
  const agentUri = (opts.agentUri ?? process.env.ECS_AGENT_URI)?.trim().replace(/\/$/, '');
  if (!agentUri) return noopTaskProtection();
  const expiresInMinutes = opts.expiresInMinutes ?? resolveProtectionExpiryMinutes();
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async set(enabled) {
      // ProtectionEnabled is the only required field; ExpiresInMinutes is ignored
      // by the agent when clearing. The agent endpoint retries control-plane blips
      // internally, so a single PUT per call is enough.
      const body = enabled
        ? JSON.stringify({ ProtectionEnabled: true, ExpiresInMinutes: expiresInMinutes })
        : JSON.stringify({ ProtectionEnabled: false });
      const res = await doFetch(`${agentUri}/task-protection/v1/state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(
          `ECS task-protection ${enabled ? 'set' : 'clear'} failed: HTTP ${res.status}`,
        );
      }
    },
  };
}

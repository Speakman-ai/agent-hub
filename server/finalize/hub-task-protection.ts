/**
 * hub-task-protection.ts — Hub-driven ECS task scale-in protection for the
 * runner fleet.
 *
 * WHY (vs. agent self-protection): the runner-agent self-protects by PUTting to
 * its LOCAL ECS container-agent endpoint ($ECS_AGENT_URI). That call is
 * best-effort and SILENTLY DROPPED under load — and a long, CPU-heavy shard is
 * exactly when it's dropped. The shard keeps heartbeating the Hub (so its queue
 * lease stays alive) while its task protection quietly lapses, so the next
 * dynamic scale-in (FINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1) terminates a job that
 * was very much alive. The longest shards are the ones in flight when a shrink
 * fires, so they bear the brunt — the observed "long tests always fail".
 *
 * The Hub, by contrast, already receives reliable heartbeats and owns the lease.
 * Tying protection to those heartbeats — arm on claim, re-arm on each received
 * heartbeat, clear on terminal/reap — makes protection EXACTLY as reliable as
 * the lease, independent of shard length or agent-side event-loop starvation.
 * If the agent can heartbeat, protection holds; if it can't, the lease expires
 * and the reaper clears it — consistent either way.
 *
 * Requires `ecs:UpdateTaskProtection` on the Hub role and the agent reporting
 * its ECS task ARN at registration (runner_agents.ecs_task_arn). Off-ECS / when
 * the cluster or task ARN is unknown, every call is a no-op, so the local 2a
 * fleet and unit tests are unaffected.
 */
import { ECSClient, UpdateTaskProtectionCommand } from '@aws-sdk/client-ecs';

/**
 * Arm window. Deliberately generous (> any realistic shard, and > the
 * orchestrator's 60-min active-time cap) so a SINGLE arm at claim already
 * outlasts the job; the lease-coupled re-arm on heartbeat then extends it for
 * anything longer. Env-overridable for ops tuning.
 */
export const DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES = 120;

/** ECS UpdateTaskProtection caps expiresInMinutes at 2880 (48h). */
export const MAX_HUB_PROTECTION_EXPIRY_MINUTES = 2880;

/**
 * Don't re-arm more than once per task in this window. With ~30s heartbeats this
 * collapses a re-arm storm to ~one UpdateTaskProtection call per task per
 * throttle window — protection is already valid for {@link
 * DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES}, so re-arming is just lease extension.
 */
export const DEFAULT_HUB_PROTECTION_REARM_THROTTLE_MS = 10 * 60_000;

/**
 * Hard ceiling on a single UpdateTaskProtection call. The claim handler AWAITS
 * the arm before handing out the job, so an unbounded SDK hang would strand the
 * claim handshake (agent never gets the job, which stays leased/busy until the
 * reaper recovers it). Bounding the call keeps protection best-effort: on
 * timeout the arm returns `error`, the claim proceeds, and the next heartbeat
 * re-arms.
 */
export const DEFAULT_HUB_PROTECTION_TIMEOUT_MS = 2000;

export interface HubTaskProtectionConfig {
  /** ECS cluster the runner agents run in (FINALIZE_FLEET_ECS_CLUSTER). */
  cluster?: string;
  /** AWS region for the ECS client. */
  region?: string;
  /** Arm window in minutes. */
  expiresInMinutes?: number;
  /** Re-arm throttle in ms. */
  rearmThrottleMs?: number;
  /** Per-call hard timeout in ms (bounds the awaited claim path). */
  timeoutMs?: number;
}

/** Resolve config live from env (read at call time so a deploy can retune). */
export function loadHubTaskProtectionConfig(): HubTaskProtectionConfig {
  // Coerce sub-1 / garbage to the default; clamp the upper bound to the ECS
  // expiresInMinutes limit so a directly-set env can't make the arm call fail.
  const n = (raw: string | undefined, dflt: number, max = Number.MAX_SAFE_INTEGER): number => {
    const v = Number.parseInt(raw?.trim() ?? '', 10);
    return Number.isFinite(v) && v >= 1 ? Math.min(v, max) : dflt;
  };
  return {
    cluster: process.env.FINALIZE_FLEET_ECS_CLUSTER?.trim() || undefined,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined,
    expiresInMinutes: n(
      process.env.FINALIZE_HUB_TASK_PROTECTION_EXPIRY_MINUTES,
      DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES,
      MAX_HUB_PROTECTION_EXPIRY_MINUTES,
    ),
    rearmThrottleMs: n(
      process.env.FINALIZE_HUB_TASK_PROTECTION_REARM_THROTTLE_MS,
      DEFAULT_HUB_PROTECTION_REARM_THROTTLE_MS,
    ),
    timeoutMs: n(
      process.env.FINALIZE_HUB_TASK_PROTECTION_TIMEOUT_MS,
      DEFAULT_HUB_PROTECTION_TIMEOUT_MS,
    ),
  };
}

/**
 * Send a command with a hard timeout. If the SDK call outruns `timeoutMs` we
 * reject (the caller treats it as a best-effort failure) but keep a `.catch` on
 * the original promise so its late settle never becomes an unhandled rejection.
 */
async function sendBounded(c: EcsSend, command: unknown, timeoutMs: number): Promise<unknown> {
  const sendP = c.send(command);
  sendP.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sendP,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`UpdateTaskProtection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Minimal seam over ECSClient so tests inject a fake (no AWS, no SDK import). */
export interface EcsSend {
  send(command: unknown): Promise<unknown>;
}

/**
 * The relevant subset of an UpdateTaskProtection response. The API returns HTTP
 * 200 even when an individual task FAILS (e.g. `TASK_NOT_VALID`, missing task) —
 * those land in `failures[]`, NOT as a thrown error. A successful arm puts the
 * task in `protectedTasks[]`.
 */
interface UpdateTaskProtectionResult {
  protectedTasks?: Array<{ taskArn?: string; protectionEnabled?: boolean }>;
  failures?: Array<{ arn?: string; reason?: string; detail?: string }>;
}

let client: EcsSend | null = null;
function ecsClient(region?: string): EcsSend {
  if (!client) client = new ECSClient(region ? { region } : {}) as unknown as EcsSend;
  return client;
}

/** Per-task last-armed timestamp, for the re-arm throttle. */
const lastArmedAt = new Map<string, number>();

/** Test seam: inject a fake client and reset throttle state. */
export function __resetHubTaskProtectionForTests(injected?: EcsSend): void {
  client = injected ?? null;
  lastArmedAt.clear();
}

export interface HubProtectionDeps {
  client?: EcsSend;
  now?: () => number;
  log?: (msg: string) => void;
  /** Bypass the re-arm throttle (use on claim — a freshly-claimed task must arm now). */
  force?: boolean;
}

export type ArmResult = 'armed' | 'throttled' | 'skipped' | 'error';
export type ClearResult = 'cleared' | 'skipped' | 'error';

/**
 * Arm (or re-arm) scale-in protection for a runner agent's ECS task. Best-effort
 * and NON-THROWING: a missing task ARN / cluster is a no-op (`skipped`), and any
 * ECS error is swallowed (`error`) so this can be fire-and-forget from a hot
 * request path. Throttled per task unless `deps.force` is set.
 */
export async function armHubTaskProtection(
  taskArn: string | null | undefined,
  cfg: HubTaskProtectionConfig,
  deps: HubProtectionDeps = {},
): Promise<ArmResult> {
  if (!taskArn || !cfg.cluster) return 'skipped';
  const now = deps.now ?? Date.now;
  if (!deps.force) {
    const throttle = cfg.rearmThrottleMs ?? DEFAULT_HUB_PROTECTION_REARM_THROTTLE_MS;
    const last = lastArmedAt.get(taskArn);
    if (last !== undefined && now() - last < throttle) return 'throttled';
  }
  const log = deps.log ?? ((m: string) => console.warn(m));
  try {
    const c = deps.client ?? ecsClient(cfg.region);
    const resp = (await sendBounded(
      c,
      new UpdateTaskProtectionCommand({
        cluster: cfg.cluster,
        tasks: [taskArn],
        protectionEnabled: true,
        expiresInMinutes: cfg.expiresInMinutes ?? DEFAULT_HUB_PROTECTION_EXPIRY_MINUTES,
      }),
      cfg.timeoutMs ?? DEFAULT_HUB_PROTECTION_TIMEOUT_MS,
    )) as UpdateTaskProtectionResult | undefined;
    // UpdateTaskProtection returns 200 even when a task fails per-task. Only
    // treat the request as armed — and only then arm the throttle — if the task
    // actually came back protected with no matching failure. Otherwise the Hub
    // would believe protection is fresh and suppress retries for the throttle
    // window while the task is in fact exposed to scale-in.
    const failure = resp?.failures?.find((f) => f?.arn === taskArn);
    const confirmed = resp?.protectedTasks?.some((t) => t?.taskArn === taskArn);
    if (failure || !confirmed) {
      log(
        `[hub-task-protection] arm ${taskArn} NOT confirmed: ${
          failure
            ? `${failure.reason ?? 'failure'}${failure.detail ? ` (${failure.detail})` : ''}`
            : 'task absent from protectedTasks'
        } — not throttling so the next heartbeat retries`,
      );
      return 'error';
    }
    lastArmedAt.set(taskArn, now());
    return 'armed';
  } catch (err) {
    log(
      `[hub-task-protection] arm ${taskArn} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }
}

/**
 * Clear protection so a now-idle (finished / reaped) task is releasable again —
 * deploys and dynamic scale-in can reclaim it. Best-effort and non-throwing; a
 * task that no longer exists (instance already reclaimed) just errors harmlessly.
 */
export async function clearHubTaskProtection(
  taskArn: string | null | undefined,
  cfg: HubTaskProtectionConfig,
  deps: HubProtectionDeps = {},
): Promise<ClearResult> {
  if (!taskArn || !cfg.cluster) return 'skipped';
  lastArmedAt.delete(taskArn);
  try {
    const c = deps.client ?? ecsClient(cfg.region);
    await sendBounded(
      c,
      new UpdateTaskProtectionCommand({
        cluster: cfg.cluster,
        tasks: [taskArn],
        protectionEnabled: false,
      }),
      cfg.timeoutMs ?? DEFAULT_HUB_PROTECTION_TIMEOUT_MS,
    );
    return 'cleared';
  } catch (err) {
    (deps.log ?? ((m: string) => console.warn(m)))(
      `[hub-task-protection] clear ${taskArn} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'error';
  }
}

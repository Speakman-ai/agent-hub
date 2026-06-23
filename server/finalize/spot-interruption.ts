/**
 * spot-interruption.ts — detect a pending EC2 Spot interruption from inside a
 * Finalize runner agent, and the cross-module contract for marking a reaped job
 * as a known Spot reclaim.
 *
 * ## Why this exists
 *
 * When AWS reclaims a Spot instance it publishes a 2-minute interruption notice
 * to the Instance Metadata Service (IMDS) at
 * `/latest/meta-data/spot/instance-action` *before* the instance is killed. The
 * runner agent polls that endpoint on its heartbeat tick; the moment a notice
 * appears it tells the Hub (via the heartbeat body) that THIS job is about to
 * lose its instance to capacity reclamation — not to a crash, an OOM kill, or a
 * deploy. The Hub records that on the queue row so that when the lease finally
 * expires (instance gone → heartbeats stop), the reaper can classify the lost
 * job as {@link import('./infra-retry.js').RECLAIM_FAILURE_REASONS spot_reclaimed}
 * instead of the generic `container_unavailable`. The reclaim class earns the
 * more generous retry-generation cap (see `resolveRetryGenerationCap`), which is
 * exactly what a Spot pool that reclaims you repeatedly needs.
 *
 * ## Safety / parity
 *
 * - **No-op off EC2.** A non-EC2 host (local fleet, a developer box, CI) has no
 *   IMDS, so the probe fails fast (connection refused / timeout / 404) and
 *   reports "not interrupted" with NO log spam. The default is always the safe
 *   direction: when we can't tell, we don't claim a reclaim, so the job falls
 *   back to the stricter `container_unavailable` cap.
 * - **IMDSv2 only.** We always fetch a session token first (`PUT
 *   /latest/api/token`) and pass it on the metadata GET. IMDSv1 (token-less) is
 *   not used.
 * - **Honors AWS opt-outs.** `AWS_EC2_METADATA_DISABLED=true` short-circuits the
 *   probe (the same env the AWS SDKs respect), and
 *   `AWS_EC2_METADATA_SERVICE_ENDPOINT` overrides the base URL (e.g. for tests
 *   or an IMDS proxy).
 */

/** Default IMDS endpoint (link-local address, same for every EC2 instance). */
export const DEFAULT_IMDS_ENDPOINT = 'http://169.254.169.254';

/** IMDSv2 session-token TTL. Six hours is the AWS maximum; we only need seconds. */
const IMDS_TOKEN_TTL_SECONDS = 21600;

/**
 * Per-request timeout for an IMDS probe. Deliberately short: off-EC2 the
 * link-local address is unroutable and we want the probe to fail fast on the
 * heartbeat tick rather than stall the loop. On EC2 the local metadata service
 * answers in single-digit milliseconds.
 */
export const IMDS_PROBE_TIMEOUT_MS = 1_000;

/**
 * Marker embedded in a step spawn-error `detail` string to signal that the
 * failure was a known Spot reclaim (the runner instance got a 2-minute
 * interruption notice before its lease expired). `step-runner.ts` reads this off
 * the spawn-error detail to choose `spot_reclaimed` over `container_unavailable`
 * as the terminal `failure_reason`.
 *
 * A plain string marker is the seam here because the only channel between the
 * Hub-side reaper and step-runner is the `Error.message` passed to
 * `RunnerJobChannel.fail()` — there is no structured failure-reason field on
 * that path. The marker is matched with {@link detailIsSpotReclaim} so the exact
 * token lives in one place.
 */
export const SPOT_RECLAIM_DETAIL_MARKER = '[spot_reclaimed]';

/**
 * Build the human-readable `detail` for a job that was lost to a Spot reclaim,
 * prefixed with {@link SPOT_RECLAIM_DETAIL_MARKER} so the classification seam in
 * step-runner can recognise it. Use for the `RunnerJobChannel.fail()` message
 * when the reaped job had a recorded interruption notice.
 */
export function spotReclaimDetail(humanMessage: string): string {
  return `${SPOT_RECLAIM_DETAIL_MARKER} ${humanMessage}`;
}

/**
 * Does a spawn-error / lost-job `detail` string indicate a known Spot reclaim?
 * Pure; safe to call from the step-runner classification hot path.
 */
export function detailIsSpotReclaim(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return detail.includes(SPOT_RECLAIM_DETAIL_MARKER);
}

/** Result of a single IMDS interruption probe. */
export interface SpotInterruptionStatus {
  /** True iff IMDS reported a pending interruption (terminate/stop/hibernate). */
  pending: boolean;
  /** The reclaim action when pending (`terminate` | `stop` | `hibernate`), else null. */
  action?: string | null;
  /** ISO-8601 time the action will occur, when pending and supplied by IMDS. */
  time?: string | null;
}

const NOT_INTERRUPTED: SpotInterruptionStatus = { pending: false, action: null, time: null };

/** A `fetch`-compatible function. Injected in tests so no real HTTP is made. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface CheckSpotInterruptionOptions {
  /** Override the IMDS base URL. Defaults to env or {@link DEFAULT_IMDS_ENDPOINT}. */
  endpoint?: string;
  /** Injected fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-request timeout. Defaults to {@link IMDS_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function resolveEndpoint(explicit?: string): string {
  const fromEnv = process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim();
  return (explicit || fromEnv || DEFAULT_IMDS_ENDPOINT).replace(/\/$/, '');
}

function metadataDisabled(): boolean {
  const v = process.env.AWS_EC2_METADATA_DISABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe IMDS once for a pending Spot interruption notice.
 *
 * Returns `{ pending: false }` on EVERY failure path — non-EC2 host, IMDS
 * disabled, token fetch failure, network error/timeout, or a 404 (the endpoint
 * returns 404 until a notice is actually published). Only an HTTP 200 with a
 * recognisable JSON body flips `pending` to true. Never throws.
 *
 * This "fail closed to not-interrupted" stance is deliberate: a false negative
 * just falls back to the stricter `container_unavailable` cap (the run still
 * retries, just less generously), whereas a false positive would over-retry a
 * deterministic failure. The safe direction is to under-claim reclaims.
 */
export async function checkSpotInterruption(
  opts: CheckSpotInterruptionOptions = {},
): Promise<SpotInterruptionStatus> {
  if (metadataDisabled()) return NOT_INTERRUPTED;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return NOT_INTERRUPTED;
  const base = resolveEndpoint(opts.endpoint);
  const timeoutMs = opts.timeoutMs ?? IMDS_PROBE_TIMEOUT_MS;

  // IMDSv2: a session token is mandatory.
  let token: string;
  try {
    const tokenRes = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${base}/latest/api/token`, {
        method: 'PUT',
        headers: { 'x-aws-ec2-metadata-token-ttl-seconds': String(IMDS_TOKEN_TTL_SECONDS) },
        signal,
      }),
    );
    if (!tokenRes.ok) return NOT_INTERRUPTED;
    token = (await tokenRes.text()).trim();
    if (!token) return NOT_INTERRUPTED;
  } catch {
    // Off-EC2 (unroutable link-local), IMDS proxy down, or timeout — not a reclaim.
    return NOT_INTERRUPTED;
  }

  try {
    const res = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(`${base}/latest/meta-data/spot/instance-action`, {
        method: 'GET',
        headers: { 'x-aws-ec2-metadata-token': token },
        signal,
      }),
    );
    // 404 = no interruption scheduled (the steady-state response). Anything
    // non-2xx → treat as no interruption.
    if (!res.ok) return NOT_INTERRUPTED;
    const body = (await res.text()).trim();
    return parseInstanceActionBody(body);
  } catch {
    return NOT_INTERRUPTED;
  }
}

/**
 * Parse the IMDS `spot/instance-action` body. AWS returns JSON like
 * `{"action":"terminate","time":"2026-06-23T02:30:00Z"}`. We treat any body that
 * names a known reclaim action as a pending interruption; an unparseable or
 * empty body is "not interrupted" (fail safe). Exposed for unit testing.
 */
export function parseInstanceActionBody(body: string): SpotInterruptionStatus {
  if (!body) return NOT_INTERRUPTED;
  try {
    const parsed = JSON.parse(body) as { action?: unknown; time?: unknown };
    const action = typeof parsed.action === 'string' ? parsed.action : null;
    if (action && KNOWN_RECLAIM_ACTIONS.has(action)) {
      return {
        pending: true,
        action,
        time: typeof parsed.time === 'string' ? parsed.time : null,
      };
    }
    return NOT_INTERRUPTED;
  } catch {
    return NOT_INTERRUPTED;
  }
}

const KNOWN_RECLAIM_ACTIONS = new Set(['terminate', 'stop', 'hibernate']);

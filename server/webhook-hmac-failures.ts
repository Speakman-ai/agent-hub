/**
 * In-memory ring buffer of recent GitHub webhook HMAC verification failures.
 *
 * Why this exists: when `server/routes/webhooks.ts` rejects a delivery with
 * 401 because both the per-repo and GitHub-App webhook secrets fail to
 * verify the `x-hub-signature-256` header, the only signal historically was
 * a single `console.warn` line. Operators had no UI affordance to notice
 * drift — they discovered it only when a downstream automation (PR review,
 * card move) silently stopped firing. This buffer feeds two surfaces:
 *
 *   1. A real-time WebSocket broadcast (`webhook_hmac_failure`) that the
 *      web client banners as a toast + browser notification.
 *   2. A `GET /api/webhooks/hmac-failures` endpoint so the operator can
 *      pull the recent failure list when they open the webhook config page.
 *
 * **Why in-memory, not a SQLite table?** HMAC-failed payloads cannot be
 * trusted (they could be spoofed by an unauthenticated caller). Persisting
 * them to disk creates an unbounded-growth surface vulnerable to abuse.
 * A bounded ring buffer caps the blast radius at MAX_FAILURES rows and
 * resets on every server restart. The console.warn line remains the
 * authoritative forensic trail.
 *
 * **Self-heal throttling.** When the failed delivery looks like a GitHub
 * App delivery (header `x-github-hook-installation-target-type: integration`)
 * and we have a `config.githubApp.webhookSecret` configured, we can attempt
 * to rotate the App's webhook secret on GitHub to match our local copy
 * via `PATCH /app/hook/config`. `shouldAttemptAppSecretHeal()` rate-limits
 * those attempts to one per HEAL_THROTTLE_MS window so a burst of bad
 * deliveries doesn't hammer GitHub's API.
 */

export interface HmacFailureEntry {
  /** Wall-clock timestamp of the failure (ms since epoch). */
  ts: number;
  /** `owner/repo` from the payload's `repository.full_name`. */
  repoFullName: string;
  /** `event` or `event.action` if the payload had an action. */
  eventLabel: string;
  /** GitHub's `x-github-delivery` header value, if present. */
  deliveryId: string | null;
  /** Comma-separated list of secret sources we tried: `repo`, `github-app`. */
  triedSources: string;
  /** True if the delivery looked like a GitHub-App-installation delivery. */
  isAppDelivery: boolean;
  /** True if a self-heal attempt was scheduled for this failure. */
  healAttempted: boolean;
  /** Result of the heal attempt, if attempted. Set asynchronously. */
  healResult?: 'ok' | 'failed' | 'skipped';
  /** Error string from the heal attempt, if it failed. */
  healError?: string;
}

const MAX_FAILURES = 50;
/** Minimum gap between two consecutive App-secret heal attempts (ms). */
const HEAL_THROTTLE_MS = 60_000;

const ring: HmacFailureEntry[] = [];
let lastHealAttemptAt = 0;

export function recordHmacFailure(
  entry: Omit<HmacFailureEntry, 'ts' | 'healAttempted'> & { healAttempted?: boolean },
): HmacFailureEntry {
  const full: HmacFailureEntry = {
    ts: Date.now(),
    healAttempted: false,
    ...entry,
  };
  ring.push(full);
  if (ring.length > MAX_FAILURES) ring.splice(0, ring.length - MAX_FAILURES);
  return full;
}

export function getRecentHmacFailures(limit = MAX_FAILURES): HmacFailureEntry[] {
  if (limit >= ring.length) return [...ring].reverse();
  return ring.slice(ring.length - limit).reverse();
}

export function clearHmacFailures(): void {
  ring.length = 0;
  lastHealAttemptAt = 0;
}

/**
 * Returns true if a self-heal attempt should be made now. Updates the
 * throttle clock on a `true` return so callers should treat it as a
 * one-shot reservation: `if (shouldAttemptAppSecretHeal()) { ... heal ... }`.
 */
export function shouldAttemptAppSecretHeal(now: number = Date.now()): boolean {
  if (now - lastHealAttemptAt < HEAL_THROTTLE_MS) return false;
  lastHealAttemptAt = now;
  return true;
}

/** Test-only escape hatch — resets the throttle clock. */
export function resetHealThrottle(): void {
  lastHealAttemptAt = 0;
}

export const __testing__ = {
  MAX_FAILURES,
  HEAL_THROTTLE_MS,
};

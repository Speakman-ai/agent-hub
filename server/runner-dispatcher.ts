/**
 * Runner dispatcher — capability-aware router for outgoing spawn /
 * stdin / cancel frames.
 *
 * Phase 1 + Phase 2 used a single Map<runnerId, ActiveRunner> in
 * `runners-ws.ts` and the transport selector pinned a project to a
 * specific `runnerId`. That's enough for one-runner-per-org topologies
 * (Shape B), but blocks:
 *
 *   - Shape A (multiple user-owned runners on one machine — laptop has
 *     a `general` runner AND a `pr-preview` runner for PR #685).
 *   - Shape C (Container Pool — many short-lived runners; the control
 *     plane has to pick a `pr-preview` slot vs. a `scaffold` slot
 *     based on what the request needs, not which runner-id is pinned
 *     to the project).
 *
 * This module is intentionally a pure function. No process state, no
 * DB access — the caller passes a snapshot of currently-connected
 * runners and a `CapabilityWant`, and the dispatcher answers "which
 * runnerId should serve this request" or `null` for "no match".
 *
 * Selection rules (in order):
 *   1. **Exact role + pr match.** When `want.pr` is set, only runners
 *      with the same `pr` AND a matching role qualify. This is how the
 *      Container Pool routes `{role:'pr-preview', pr:685}` to the slot
 *      that was attached to PR 685 specifically.
 *   2. **Exact role match.** When `want.role` is set (without `pr`),
 *      runners with that role qualify regardless of their `pr` field.
 *   3. **General fallback.** When `want.role` is unset OR is
 *      `'general'`, any runner with `role === 'general'` qualifies.
 *      This is what 99% of normal chat sessions hit.
 *   4. **No match → `null`.** The caller decides whether to queue,
 *      reject, or fall back to a different transport.
 *
 * Within the qualifying set, the runner with the oldest `lastUsedAt`
 * wins — i.e. round-robin ordered by least-recently-picked. `null`
 * (never picked) sorts before any timestamp, so a brand-new runner
 * always grabs the next request. Ties break on `runnerId` (lexicographic)
 * so the choice is deterministic for tests.
 */

import type { RunnerRole } from '../shared/runner-protocol.js';

/**
 * What a caller wants from a runner. All fields optional — an empty
 * object means "any general runner will do". The dispatcher never
 * mutates this value.
 */
export interface CapabilityWant {
  /** Which role to target. `undefined` is treated as `'general'`. */
  role?: RunnerRole;
  /** PR number — only meaningful with `role: 'pr-preview'`. When set,
   * only runners with the same `pr` qualify. */
  pr?: number;
  /** Inbound port — reserved for future routing (e.g. preview HTTP
   * proxies); not consulted by the current selector but accepted so
   * callers in `pool-eviction.ts` can pass-through their full want. */
  port?: number;
}

/**
 * The minimum a dispatcher needs to know about an active runner.
 * Mirrors the fields `runners-ws.ts` already tracks — kept separate
 * here so the dispatcher stays unit-testable without a live WS.
 */
export interface RunnerSnapshot {
  runnerId: string;
  /** Resolved role — defaults to `'general'` if the runner advertised
   * no role at auth time. */
  role: RunnerRole;
  /** PR number from auth-time capabilities, when set. */
  pr?: number;
  /** Port from auth-time capabilities, when set. */
  port?: number;
  /** ISO timestamp of the last time the dispatcher picked this runner.
   * `null` for "never picked" — sorts first in round-robin order. */
  lastUsedAt: string | null;
}

/**
 * Pick the best runner for the given want, or `null` when no runner in
 * the registry qualifies.
 *
 * The function is pure: no logging, no I/O, no mutation. Callers wrap
 * it with their own bookkeeping (the WS layer stamps `lastUsedAt` on
 * pick, the transport raises `RUNNER_OFFLINE` on null, etc.).
 */
export function pickRunner(want: CapabilityWant, registry: RunnerSnapshot[]): string | null {
  if (registry.length === 0) return null;

  const desiredRole: RunnerRole = want.role ?? 'general';

  // Stage 1: build the qualifying set per the rules above.
  const qualifying = registry.filter((r) => {
    if (r.role !== desiredRole) return false;
    // When the want pins a specific PR, only same-PR runners qualify.
    // When the want leaves `pr` unset, every role-matching runner
    // qualifies regardless of whether THEY have a pr field — a general
    // runner without a pr is the obvious case, but a stray
    // `pr-preview` runner with `pr=42` also qualifies for a vague
    // `{role:'pr-preview'}` want (the Pool will narrow further before
    // calling us in practice).
    if (want.pr !== undefined && r.pr !== want.pr) return false;
    return true;
  });

  if (qualifying.length === 0) return null;

  // Stage 2: round-robin on lastUsedAt (oldest first), then runnerId
  // (lexicographic) for deterministic tie-breaking.
  qualifying.sort((a, b) => {
    const ta = a.lastUsedAt;
    const tb = b.lastUsedAt;
    if (ta === tb) return a.runnerId < b.runnerId ? -1 : a.runnerId > b.runnerId ? 1 : 0;
    if (ta === null) return -1;
    if (tb === null) return 1;
    return ta < tb ? -1 : 1;
  });

  return qualifying[0]!.runnerId;
}

/**
 * provenance.ts — Finalize Code Changes, PR provenance marker (design §11).
 *
 * Reliable way for the webhook side to tell whether a GitHub PR was pushed
 * by the Finalize orchestrator (internal) or by an external actor
 * (contributor, dependabot, direct GH push). The push step (card 5c34b2de)
 * writes `finalize_runs.pr_url` and stamps the PR body with a hidden
 * marker; the webhook handler reads the registry first and falls back to
 * scanning the body when the registry misses.
 *
 * Two signals, in priority order:
 *
 *   1. **Server-side registry (authoritative).** `finalize_runs.pr_url` is
 *      populated atomically with the push step. A row keyed on this PR
 *      URL means the orchestrator pushed it.
 *
 *   2. **PR body marker (self-describing fallback).** A hidden HTML
 *      comment `<!-- hub-actions: finalized -->` is injected into the PR
 *      body when the orchestrator opens the PR. Survives every read path
 *      that can see the PR body (humans, future tooling, webhook payload
 *      `pull_request.body`). Used when the registry lookup misses (DB
 *      reset, schema reset, manual surgery, ad-hoc dogfood deploys, etc.).
 *
 * Commit trailers were considered and rejected: rebases drop them, and a
 * single-source-of-truth on the server (registry + body marker) is
 * cleaner than parsing per-commit metadata.
 *
 * At v0 the differentiation is shipped but **not gated on**. The
 * merge-close webhook handler treats internal and external PRs the same
 * way (both move their card to Done). The marker is shipped now so v1+
 * work that re-enables webhook reviewer flows does not require a
 * historical backfill.
 *
 * See wiki: `finalize-code-changes-architecture-v0` (§11).
 */
import type { FinalizeRunRow, Stmts } from '../types.js';

/**
 * Hidden HTML comment we inject into the PR body when the orchestrator
 * opens the PR. Chosen to be:
 *
 *   - Invisible in rendered GitHub markdown (HTML comments are stripped).
 *   - Greppable on the raw `pull_request.body` from the webhook payload.
 *   - Stable across PR edits — humans can edit around it and we still
 *     classify the PR as internal.
 *
 * The exact string is part of the public contract. If you ever change it,
 * historical PRs stop classifying via the fallback path; coordinate with
 * any consumer that scans body markers directly.
 */
export const PR_BODY_MARKER = '<!-- hub-actions: finalized -->';

/**
 * Provenance classification of a PR.
 *
 *   - `'internal'` — orchestrator pushed it (registry hit OR body marker).
 *   - `'external'` — neither signal present. The PR came from a human,
 *     a bot like dependabot, or a direct `git push` that bypassed the
 *     orchestrator. Treated identically to internal at v0 by the
 *     merge-close handler; v1+ may diverge.
 */
export type PrProvenance = 'internal' | 'external';

/**
 * How the classification was reached. Useful for log lines and for the
 * webhook handler to record which path fired (so we can later catch
 * regressions where the registry write is dropping but the body marker
 * is silently rescuing us).
 *
 *   - `'registry'` — `finalize_runs.pr_url` matched the URL. Authoritative.
 *   - `'body_marker'` — registry missed, but the PR body contained the
 *     hidden marker. Fallback path.
 *   - `'none'` — neither matched; classified as external.
 */
export type ProvenanceVia = 'registry' | 'body_marker' | 'none';

export interface ProvenanceClassification {
  provenance: PrProvenance;
  via: ProvenanceVia;
  /**
   * The finalize_runs row that matched, when classification came via
   * the registry. `null` for body-marker or external classifications.
   */
  run: FinalizeRunRow | null;
}

/**
 * Idempotency: detect whether a PR body already carries the marker.
 * Used both by {@link ensurePrBodyMarker} (don't double-stamp) and by
 * {@link classifyPr}'s fallback path (read-side).
 *
 * `null` / `undefined` / empty bodies all return `false` without
 * throwing — the GitHub webhook payload's `pull_request.body` is
 * nullable on the wire and we don't want this helper to be a foot-gun.
 */
export function hasPrBodyMarker(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.includes(PR_BODY_MARKER);
}

/**
 * Stamp a PR body with the marker iff it isn't already there.
 *
 * The marker is appended as a trailing line (separated by a blank line
 * from the existing body) so it does not interfere with rendered markdown
 * above it. `null` / `undefined` / empty input is normalised to a
 * marker-only body so the orchestrator can hand us whatever it computed
 * without a pre-check.
 *
 * Idempotent by contract: re-stamping an already-marked body returns it
 * unchanged. The acceptance criterion is that the marker appears exactly
 * once.
 */
export function ensurePrBodyMarker(body: string | null | undefined): string {
  const normalized = body ?? '';
  if (hasPrBodyMarker(normalized)) return normalized;
  if (normalized.length === 0) return PR_BODY_MARKER;
  // Strip a single trailing newline so we get exactly one blank-line
  // separator between the existing body and the marker line.
  const trimmed = normalized.endsWith('\n') ? normalized.replace(/\n+$/, '') : normalized;
  return `${trimmed}\n\n${PR_BODY_MARKER}`;
}

export interface ClassifyPrDeps {
  stmts: Pick<Stmts, 'getFinalizeRunByPrUrl'>;
  /**
   * Optional fetcher invoked when the registry lookup misses. Returning
   * the raw `pull_request.body` from the incoming webhook payload is the
   * preferred shape — that field is the one place the marker is
   * guaranteed to survive without a GitHub API round-trip. Tests
   * (and call-sites that already have the body in hand) usually inline
   * this as `async () => incomingPrBody`.
   *
   * Throwing or rejecting from the fetcher is treated as "fallback
   * unavailable" and the classification falls through to `'external'`
   * rather than propagating the error — the caller decides what to do
   * with that. Network blips inside the webhook handler must not turn
   * into 500s for unrelated events.
   */
  fetchPrBody?: (prUrl: string) => Promise<string | null | undefined>;
}

/**
 * Full classification — exposes which signal fired (`via`) and the
 * matching `finalize_runs` row when the registry hit. Most call-sites
 * want the boolean shortcut {@link isInternalPr} below; this is the
 * fuller surface for logging / debugging / v1+ gating.
 */
export async function classifyPr(
  deps: ClassifyPrDeps,
  prUrl: string,
): Promise<ProvenanceClassification> {
  if (!prUrl || prUrl.length === 0) {
    return { provenance: 'external', via: 'none', run: null };
  }
  // 1. Registry lookup — authoritative.
  const run = deps.stmts.getFinalizeRunByPrUrl.get(prUrl) as FinalizeRunRow | undefined;
  if (run) {
    return { provenance: 'internal', via: 'registry', run };
  }
  // 2. Body marker fallback — best-effort.
  if (deps.fetchPrBody) {
    let body: string | null | undefined;
    try {
      body = await deps.fetchPrBody(prUrl);
    } catch {
      // Fetcher failures are intentionally swallowed — see the JSDoc
      // on `fetchPrBody` above. We treat the fallback as unavailable
      // and fall through.
      body = undefined;
    }
    if (hasPrBodyMarker(body)) {
      return { provenance: 'internal', via: 'body_marker', run: null };
    }
  }
  return { provenance: 'external', via: 'none', run: null };
}

/**
 * Boolean shortcut over {@link classifyPr}. Use this from the webhook
 * handler when the only decision you need is "should this code path
 * treat the PR as internal?".
 */
export async function isInternalPr(deps: ClassifyPrDeps, prUrl: string): Promise<boolean> {
  const result = await classifyPr(deps, prUrl);
  return result.provenance === 'internal';
}

export interface WriteFinalizeRunPrUrlDeps {
  stmts: Pick<Stmts, 'updateFinalizeRunPrUrl'>;
}

/**
 * Write the PR URL into the finalize_runs row for `runId`.
 *
 * The push step (card 5c34b2de) calls this **inside the same
 * transaction** as the actual `git push` + `gh pr create` sequence so
 * the registry can never get out-of-sync with what's on GitHub. Doing
 * the write here without a transaction is supported (some test paths
 * do this), but production callers wrap the push and this write in a
 * single `db.transaction(...)` block.
 *
 * Idempotent at the registry layer: writing the same `runId` /
 * `prUrl` pair twice is a no-op (UPDATE with identical values). Writing
 * a different `prUrl` for the same `runId` overwrites — the orchestrator
 * never re-pushes a finalize run, so this is a latent invariant not
 * enforced here.
 */
export function writeFinalizeRunPrUrl(
  deps: WriteFinalizeRunPrUrlDeps,
  args: { runId: string; prUrl: string },
): void {
  deps.stmts.updateFinalizeRunPrUrl.run(args.prUrl, args.runId);
}

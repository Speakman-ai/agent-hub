/**
 * One-shot, per-org backfill that seeds the per-project QA agent (role `qa`)
 * into projects created before QA agents existed.
 *
 * New projects get their QA agent at creation (`ensureQaAgents(project.id)` in
 * routes/projects.ts). Existing projects need it once. `ensureQaAgents()` is
 * idempotent per project but cannot tell "never had one" from "user deleted
 * theirs", so running it on every boot would resurrect a QA agent a user
 * removed. A marker file in the org data dir makes this run exactly once per
 * org, the same guard the Skill Builder backfill uses.
 *
 * Only the active org's `projects.json` is in memory at a time, so the caller
 * runs this at boot for the startup org and in the org-switch path for the rest.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export const QA_AGENT_BACKFILL_MARKER = '.qa-agent-backfill-v1.done';

export interface BackfillQaAgentsResult {
  /** True when the backfill ran this call; false when the marker already existed. */
  ran: boolean;
  markerPath: string;
}

export function backfillQaAgents(opts: {
  dataDir: string;
  /** The no-arg (iterate-all) form of project-model's `ensureQaAgents`. */
  ensureQaAgents: () => void;
  nowIso?: () => string;
}): BackfillQaAgentsResult {
  const markerPath = path.join(opts.dataDir, QA_AGENT_BACKFILL_MARKER);
  if (existsSync(markerPath)) return { ran: false, markerPath };

  opts.ensureQaAgents();

  // Marker last: a crash mid-seed re-runs the idempotent seed next boot.
  mkdirSync(opts.dataDir, { recursive: true });
  const stamp = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  writeFileSync(markerPath, `${stamp}\n`, 'utf-8');
  return { ran: true, markerPath };
}

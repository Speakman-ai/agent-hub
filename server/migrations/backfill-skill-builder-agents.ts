/**
 * backfill-skill-builder-agents.ts — one-shot, per-org backfill that seeds the
 * conversational **Skill Builder** coach into projects that predate the
 * feature.
 *
 * Why: the per-project Skill Builder agent (role `skill-builder`) is the coach
 * behind the web Skills page's **Build a skill** button — that button only
 * renders when the active project actually has such an agent
 * (`SkillsPage.jsx`: `coachAgent` / `canCoach`). The agent is seeded only at
 * project-creation time and is deliberately NOT backfilled on every boot (see
 * `ensureSkillBuilderAgents` in `project-model.ts`), so every project created
 * before the feature shipped is missing its coach and the button is invisible
 * there. This migration adds the coach to those existing projects once.
 *
 * Guard: a marker file in the org data dir makes this run **exactly once per
 * org**. That matters because `ensureSkillBuilderAgents()` is idempotent on a
 * per-project basis (it skips a project that already has a builder) but cannot
 * tell "never had one" from "user deleted theirs" — running it on every boot
 * would resurrect a coach a user intentionally removed. The marker means the
 * backfill respects later deletions, matching the project-model philosophy that
 * existing projects keep whatever roster they're left with.
 *
 * Multi-org: the active org's `projects.json` is the only one loaded in memory
 * at any moment (`initProjects` / `reloadProjects`). The caller invokes this
 * after projects are loaded for an org — at boot for the startup org and inside
 * the org-switch path for the rest — so each org is backfilled the first time
 * it becomes active.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

/** Marker file written into the org data dir once the backfill has run. */
export const SKILL_BUILDER_BACKFILL_MARKER = '.skill-builder-backfill-v1.done';

export interface BackfillSkillBuilderResult {
  /** True when the backfill ran this call; false when the marker already existed. */
  ran: boolean;
  /** Absolute path to the per-org marker file. */
  markerPath: string;
}

/**
 * Run the per-org Skill Builder backfill once. Idempotent across calls: the
 * first call invokes `ensureSkillBuilderAgents` (its no-arg, iterate-all shape)
 * and drops the marker; subsequent calls short-circuit on the marker.
 *
 * `ensureSkillBuilderAgents` is injected (rather than imported) so this stays a
 * thin, side-effect-isolated unit that's trivial to test against a temp dir.
 */
export function backfillSkillBuilderAgents(opts: {
  dataDir: string;
  /** The no-arg (iterate-all) form of project-model's `ensureSkillBuilderAgents`. */
  ensureSkillBuilderAgents: () => void;
  /** Override the marker timestamp source (tests). Defaults to `new Date()`. */
  nowIso?: () => string;
}): BackfillSkillBuilderResult {
  const markerPath = path.join(opts.dataDir, SKILL_BUILDER_BACKFILL_MARKER);

  if (existsSync(markerPath)) {
    return { ran: false, markerPath };
  }

  opts.ensureSkillBuilderAgents();

  // Persist the marker last so a crash mid-seed re-runs the (idempotent) seed
  // on the next boot rather than skipping a half-finished backfill.
  mkdirSync(opts.dataDir, { recursive: true });
  const stamp = opts.nowIso ? opts.nowIso() : new Date().toISOString();
  writeFileSync(markerPath, `${stamp}\n`, 'utf-8');

  return { ran: true, markerPath };
}

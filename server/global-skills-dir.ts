import path from 'path';
import config from './config.js';

/**
 * The writable **global** skill tier.
 *
 * Agent Hub has two skill scopes today, decided purely by filesystem location:
 *   - **Bundled defaults** — `server/default-skills/`, baked into the repo at
 *     deploy time, available to every agent in every project.
 *   - **Project skills** — `<project.ahw>/skills/`, visible only to that
 *     project's agents.
 *
 * The gap this dir closes: there was no *runtime-writable* shared tier — a skill
 * authored "shared across all projects" had nowhere to live except the baked-in
 * defaults. Global skills live here, alongside `config.json` / `projects.json`
 * in the data dir, and are read by `listMergedSkills` + `loadSkillBody` BETWEEN
 * the project tier and the bundled-default tier. Precedence is therefore:
 *
 *     project  >  global  >  bundled default
 *
 * (project wins on a same-id conflict, mirroring Claude Code's
 * project-over-user precedence).
 *
 * Resolved from `config.dataDir` (honors `AGENT_HUB_DATA_DIR` / `dataDir` in
 * config.json), so tests pointing at a tmp data dir get an isolated global tier.
 *
 * Returns `''` when `config.dataDir` is not a usable string (e.g. unit tests
 * that mock `./config.js` without a `dataDir`). Callers treat an empty dir as
 * "no global tier": `collectSkillsFromDir('')` yields `[]` and `loadSkillBody`
 * skips a falsy root — so the prompt builder degrades gracefully instead of
 * throwing on `path.join(undefined, …)`.
 */
export function resolveGlobalSkillsDir(): string {
  const dataDir = config.dataDir;
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return '';
  return path.join(dataDir, 'skills');
}

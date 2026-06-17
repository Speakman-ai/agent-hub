/**
 * Let a session's worktree drive its own preview compose config.
 *
 * The preview runtime reads `project.prEnv.preview.compose` from the PROJECT
 * record. That means editing `.agent-hub/preview.json` in a repo and committing
 * it does NOT change how that session's preview boots — a confusing gap,
 * especially for live-mount fields (`entryWorkdir`) that turn on HMR.
 *
 * This module reads the session worktree's `.agent-hub/preview.json` at boot and
 * merges a safe subset of its `prEnv.preview.compose` fields over the project
 * config, so the committed repo file actually drives the session's preview.
 *
 * Scope of the override is deliberately narrow:
 *   - Only the compose SHAPE + live-mount fields are overridable. Health/timeout
 *     and host-port-pool policy stay project-owned (operator concerns, not repo).
 *   - `prEnv.preview.enabled` is NOT touched — a worktree file can shape an
 *     already-enabled preview but can never enable one the project disabled.
 *   - Invalid values are ignored field-by-field (fall back to project config),
 *     so a malformed repo file degrades gracefully instead of breaking boot.
 */
import { readFileSync } from 'fs';
import path from 'path';
import type { PreviewComposeConfig, Project } from '../types.js';

// Compose fields a worktree `.agent-hub/preview.json` may override. Limited to
// the compose SHAPE + live-mount fields. `healthPath` is intentionally EXCLUDED
// — readiness semantics stay project-owned so a PR can't mask a broken app with
// a trivial endpoint (or force startup to fail). Same for timeout/port-pool.
const OVERRIDABLE_KEYS = [
  'entryService',
  'entryPort',
  'file',
  'entryWorkdir',
  'entrySourceDir',
  'shadowDirs',
] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** entryWorkdir must be an absolute container path. */
function validEntryWorkdir(v: unknown): v is string {
  return isNonEmptyString(v) && v.startsWith('/');
}

/** A worktree-relative path: non-empty, not absolute, no `..` segment. */
function isSafeRelativePath(v: unknown): v is string {
  return isNonEmptyString(v) && !v.startsWith('/') && !v.split(/[\\/]/).includes('..');
}

/** entrySourceDir is a worktree-relative path; reject absolute or `..` escapes. */
function validEntrySourceDir(v: unknown): v is string {
  return isSafeRelativePath(v);
}

/**
 * shadowDirs are mounted as anonymous volumes at `<entryWorkdir>/<dir>`, so each
 * entry must be a worktree-relative path — reject absolute or `..` escapes that
 * a PR-controlled preview.json could use to shadow unexpected paths. The whole
 * field is rejected (falls back to project config) if any entry is unsafe.
 */
function validShadowDirs(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isSafeRelativePath);
}

/**
 * Merge the worktree compose fields over the project compose config. Pure.
 * Unknown/invalid fields are skipped so the project value wins for them.
 */
export function mergePreviewComposeFromWorktree(
  projectCompose: PreviewComposeConfig | undefined,
  worktreeCompose: unknown,
): PreviewComposeConfig | undefined {
  if (!worktreeCompose || typeof worktreeCompose !== 'object') return projectCompose;
  const src = worktreeCompose as Record<string, unknown>;
  // Cast through unknown: we only ever assign validated values below.
  const merged = { ...(projectCompose ?? {}) } as Record<string, unknown>;

  for (const key of OVERRIDABLE_KEYS) {
    const value = src[key];
    if (value === undefined) continue;
    if (key === 'entryWorkdir' && !validEntryWorkdir(value)) continue;
    if (key === 'entrySourceDir' && !validEntrySourceDir(value)) continue;
    if (key === 'shadowDirs' && !validShadowDirs(value)) continue;
    if (key === 'entryService' && !isNonEmptyString(value)) continue;
    if (key === 'entryPort' && !(typeof value === 'number' && Number.isFinite(value))) continue;
    // `file` selects the compose file; keep it inside the worktree (no absolute
    // paths or `..` escapes), same as entrySourceDir/shadowDirs.
    if (key === 'file' && !isSafeRelativePath(value)) continue;
    merged[key] = value;
  }

  return merged as unknown as PreviewComposeConfig;
}

/**
 * Read `<worktreePath>/.agent-hub/preview.json` and return its
 * `prEnv.preview.compose` object, or null when missing/unreadable/invalid.
 * `readFile` is injectable for tests.
 */
export function readWorktreePreviewCompose(
  worktreePath: string,
  readFile: (p: string, enc: 'utf8') => string = readFileSync,
): unknown {
  if (!isNonEmptyString(worktreePath)) return null;
  try {
    const raw = readFile(path.join(worktreePath, '.agent-hub', 'preview.json'), 'utf8');
    const parsed = JSON.parse(raw) as { prEnv?: { preview?: { compose?: unknown } } };
    return parsed?.prEnv?.preview?.compose ?? null;
  } catch {
    return null;
  }
}

/**
 * Return a Project whose `prEnv.preview.compose` has the worktree overrides
 * applied. Returns the original project unchanged when there is no worktree
 * file or no project-level preview to attach the override to.
 */
export function projectWithWorktreePreviewOverride(
  project: Project,
  worktreePath: string,
  readFile: (p: string, enc: 'utf8') => string = readFileSync,
): Project {
  // Never enable previews from a worktree file — only shape an existing one.
  if (!project.prEnv?.preview) return project;

  const worktreeCompose = readWorktreePreviewCompose(worktreePath, readFile);
  if (!worktreeCompose) return project;

  const mergedCompose = mergePreviewComposeFromWorktree(
    project.prEnv.preview.compose,
    worktreeCompose,
  );

  return {
    ...project,
    prEnv: {
      ...project.prEnv,
      preview: { ...project.prEnv.preview, compose: mergedCompose },
    },
  };
}

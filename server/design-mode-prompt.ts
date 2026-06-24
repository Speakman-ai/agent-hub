/**
 * Design-mode system-prompt preamble — the worktree-based successor to
 * `buildDesignSystemPrompt` (design-chat.ts).
 *
 * When a normal chat session runs in `session_mode = 'design'` (see
 * `session-mode.ts`), the spawn path in `chat.ts` prepends this preamble so the
 * agent knows it is in Design mode. Unlike the legacy Design Studio path, the
 * artifacts live in a `design/` subdirectory of the *session worktree* — not a
 * standalone `<dataDir>/designs/<id>/` dir. Keeping them in the worktree is what
 * makes "flip Design → Build and the artifacts carry over" free: it is the same
 * checkout, so no copy/forward step is needed.
 *
 * Scope split vs. the `design` skill:
 *   - The `design` SKILL.md body (identity + working rules) is force-loaded by
 *     id in the chat spawn path (`augmentChatTurnForDesignMode` →
 *     `requiredSkillIdsForSession`, below), independent of the message-driven
 *     skill router so it can never be displaced or allowlist-filtered.
 *   - This preamble carries only the *worktree-specific* context the skill body
 *     can't know: where to write artifacts (`design/`), the linked-project
 *     design-system docs, and a snapshot of the files already produced.
 *
 * Pure except for filesystem reads, so it unit-tests against a temp worktree.
 */
import {
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import path from 'path';
import { isDesignModeActive, isScopingModeActive } from './session-mode.js';
import type { Project } from './types.js';

/** Subdirectory of the session worktree that holds design artifacts. */
export const DESIGN_MODE_SUBDIR = 'design';

/** Skill id (bundled default skill) that authors design artifacts. */
export const DESIGN_SKILL_ID = 'design';

/**
 * Skills that MUST be force-loaded for a session based on its mode, independent
 * of the message-driven skill router. The router can't guarantee this: it bails
 * (returns `[]`) when the user's message contains an explicit `<agenthub:skill>`
 * block, and it is also filtered by the agent's allowlist — either of which
 * would silently drop the `design` skill on a design-mode turn. The spawn path
 * loads these by id every applicable turn so the SKILL.md body is always present
 * alongside the design-mode preamble.
 *
 * Pure: derives only from `session_mode` via the canonical `isDesignModeActive`
 * (the single normalization path — no second looser lowercase/trim check).
 */
export function requiredSkillIdsForSession(
  session: { session_mode?: string | null } | null | undefined,
): string[] {
  if (isDesignModeActive(session)) return [DESIGN_SKILL_ID];
  if (isScopingModeActive(session)) return ['agent-hub-kanban'];
  return [];
}

export interface EnsureRealDesignDirResult {
  /** Absolute path to the artifact dir (`<worktreePath>/<subdir>`). */
  dir: string;
  /** True iff `dir` is a real directory in the worktree after this call. */
  ok: boolean;
  /** True iff a symlinked root was found and removed (neutralized). */
  neutralizedSymlink: boolean;
}

/**
 * Ensure the design artifact root `<worktreePath>/<subdir>` is a REAL directory
 * inside the worktree before the spawn path tells the agent to write there.
 *
 * Why this is not just `mkdirSync(..., { recursive: true })`: `mkdirSync` (like
 * `existsSync`) follows symlinks, so if the worktree already contains
 * `design -> /somewhere/else` (committed, or planted), the mkdir is a silent
 * no-op and every design-mode write lands OUTSIDE the session worktree —
 * breaking the "artifacts stay in the checkout" contract and risking
 * overwrites. `listDesignModeFiles` already refuses to *read* a symlinked root;
 * this closes the *write* side.
 *
 * Neutralization removes the symlink itself with `unlinkSync` (never its
 * target — we do not follow or delete anything outside the worktree) and creates
 * a real empty directory in its place. ENOENT / a normal existing dir need no
 * action. Best-effort and never throws; `ok` reports whether the root is a real
 * directory afterward so the caller can decide whether design writes are safe.
 */
export function ensureRealDesignDir(
  worktreePath: string,
  subdir: string = DESIGN_MODE_SUBDIR,
): EnsureRealDesignDirResult {
  const dir = path.join(worktreePath, subdir);
  let neutralizedSymlink = false;
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      // Remove the link entry only — unlinkSync never touches the link target.
      unlinkSync(dir);
      neutralizedSymlink = true;
    }
  } catch {
    // ENOENT (no root yet) or stat error — nothing to neutralize.
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort — fall through to the post-condition check below.
  }
  let ok = false;
  try {
    // Re-check with lstat: a real directory, not a symlink that re-materialized.
    const st = lstatSync(dir);
    ok = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    ok = false;
  }
  return { dir, ok, neutralizedSymlink };
}

/** Cap the file snapshot so a large design can't blow up the per-turn prompt. */
const MAX_LISTED_FILES = 200;

/**
 * Recursively list regular files under `<worktreePath>/<subdir>`, returned as
 * sorted forward-slash paths relative to that subdir. Missing dir → empty list.
 *
 * Symlinks (to files OR directories) are skipped: entries are classified with
 * `lstatSync`, which does NOT follow links, so a symlinked directory can never
 * make the walk escape the artifact dir or recurse through a cycle. This applies
 * to the artifact ROOT too — if `<worktreePath>/<subdir>` is itself a symlink we
 * reject it outright (return []) rather than following it, so a malicious or
 * accidental `design` symlink cannot disclose filenames outside the worktree
 * into the model prompt. As defense-in-depth we also dedupe directories by
 * resolved realpath, so even a non-symlink cycle (e.g. a bind mount) cannot
 * loop. Capped at MAX_LISTED_FILES. Never throws — a read/stat error skips that
 * entry.
 */
export function listDesignModeFiles(
  worktreePath: string,
  subdir: string = DESIGN_MODE_SUBDIR,
): string[] {
  const root = path.join(worktreePath, subdir);
  if (!existsSync(root)) return [];
  // Reject a symlinked artifact root before walking — lstat the root itself, not
  // just its children. existsSync() follows links, so a `design` symlink passes
  // the check above; this lstat is what closes the escape. A dangling symlink
  // already returns [] via existsSync.
  try {
    if (lstatSync(root).isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const visitedDirs = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    if (out.length >= MAX_LISTED_FILES) return;
    // Dedupe by realpath so a directory is never walked twice (cycle guard).
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_LISTED_FILES) return;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        // lstat, not stat: classify the entry itself, never the symlink target.
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // skip symlinked files and dirs
      if (st.isDirectory()) {
        walk(abs, relPath);
      } else if (st.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * Linked-project design-system docs: prefer `DESIGN_SYSTEM.md`, else `SOUL.md`
 * from the project's workspace (`ahw`). Returns null when neither exists or the
 * project has no workspace path. Mirrors the legacy reader in design-chat.ts so
 * design-mode sessions honour the same per-project design language.
 */
export function readProjectDesignDocs(project: Project): string | null {
  const ahw = project.ahw;
  const candidates = [
    ahw ? path.join(ahw, 'DESIGN_SYSTEM.md') : null,
    ahw ? path.join(ahw, 'SOUL.md') : null,
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        return readFileSync(file, 'utf-8').trim();
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return null;
}

export interface DesignModePreambleOpts {
  /** Absolute path to the session's git worktree. */
  worktreePath: string;
  /** Projects linked to this session, for design-system docs. */
  linkedProjects?: Project[];
  /** Artifact subdir (default `design/`). */
  subdir?: string;
  /**
   * Whether the artifact dir is a real, usable directory (from
   * `ensureRealDesignDir(...).ok`). Defaults to `true`. When `false` the
   * preamble surfaces an explicit error + recovery path instead of blindly
   * instructing the agent to write into an impossible `<subdir>/index.html`.
   */
  artifactDirReady?: boolean;
  /**
   * Whether this session has an isolated git worktree. Defaults to `true`. When
   * `false`, design mode is inactive: there is nowhere safe to write artifacts
   * (falling back to the shared project checkout would pollute it and break the
   * Design→Build handoff), so the preamble explains design mode is unavailable
   * rather than instructing any writes. Takes precedence over `artifactDirReady`.
   */
  worktreeAvailable?: boolean;
}

/**
 * Build the design-mode preamble prepended to the enriched system prompt for a
 * `session_mode = 'design'` turn. Does NOT include the `design` skill body —
 * that is force-loaded by id in the spawn path (`augmentChatTurnForDesignMode`
 * → `requiredSkillIdsForSession`). Returns a trimmed block; never empty.
 *
 * When `artifactDirReady === false` (a non-directory entry occupies `<subdir>/`,
 * or the directory could not be created), the preamble does NOT tell the agent
 * to write `index.html` — it explains the blockage and gives an actionable
 * recovery path, so the turn never instructs writing into an impossible path.
 */
export function buildDesignModePreamble(opts: DesignModePreambleOpts): string {
  const subdir = opts.subdir || DESIGN_MODE_SUBDIR;
  const sections: string[] = [];

  // No isolated worktree: design mode cannot run. Writing `design/` into the
  // shared project checkout would pollute it and break the Design→Build handoff
  // (which relies on the same worktree). Explain rather than instruct any write.
  if (opts.worktreeAvailable === false) {
    sections.push(
      [
        '## Design Mode — unavailable (no session worktree)',
        '',
        'This session is in **Design mode**, but it has no isolated git worktree.',
        `Design mode writes artifacts under \`${subdir}/\` in the session worktree so`,
        'they carry over to Build mode; without a worktree those files would land in',
        'the shared project checkout and pollute it, so **design mode is inactive for',
        'this session**.',
        '',
        `**Do not create a \`${subdir}/\` directory or write design artifacts in the`,
        'current working directory.** To use Design mode, start a session that has',
        'its own worktree and select Design mode there. Otherwise continue as a',
        'normal chat session.',
      ].join('\n'),
    );

    for (const project of opts.linkedProjects ?? []) {
      const docs = readProjectDesignDocs(project);
      if (docs) {
        sections.push(`## Design System — ${project.name}\n\n${docs}`);
      }
    }
    return sections.join('\n\n').trim();
  }

  // Blocked: the artifact dir is not usable. Surface a clear error + recovery
  // path instead of the normal "write your files here" instructions.
  if (opts.artifactDirReady === false) {
    sections.push(
      [
        '## Design Mode — artifact directory unavailable',
        '',
        'This session is in **Design mode**, but the design artifact directory',
        `\`${subdir}/\` could not be prepared: a non-directory entry already exists`,
        `at \`${subdir}\` in your worktree, or the directory could not be created.`,
        '**Do not write any design files yet** — `' + subdir + '/index.html` is not',
        'a usable path until this is resolved.',
        '',
        'Resolve it first, then proceed:',
        `- Inspect the path: \`ls -la ${subdir}\` (it is likely a regular file or an`,
        '  unreadable entry).',
        `- Remove or rename the conflicting entry so \`${subdir}/\` can be a real`,
        `  directory (e.g. \`git rm ${subdir}\` if tracked, or move it aside).`,
        `- Recreate it as a directory and add \`${subdir}/index.html\` as the entry`,
        '  point.',
        '',
        `Design artifacts must live under \`${subdir}/\` in this worktree so the live`,
        'canvas can render them and Build mode inherits them — do not write them',
        'elsewhere.',
      ].join('\n'),
    );

    for (const project of opts.linkedProjects ?? []) {
      const docs = readProjectDesignDocs(project);
      if (docs) {
        sections.push(`## Design System — ${project.name}\n\n${docs}`);
      }
    }
    return sections.join('\n\n').trim();
  }

  sections.push(
    [
      '## Design Mode',
      '',
      'This session is in **Design mode**. Build self-contained HTML/CSS/JS',
      `prototypes inside the \`${subdir}/\` subdirectory of your working directory`,
      '(the session worktree). Keep the prototype self-contained: prefer vanilla',
      'HTML + CSS + a single JS file, and pull any libraries from an allowlisted',
      'CDN (`https://cdn.tailwindcss.com`, `https://unpkg.com`) rather than a build',
      'step.',
      '',
      `- Canonical entry point: \`${subdir}/index.html\`. The live canvas renders this file.`,
      `- Write every design file under \`${subdir}/\` so it is both renderable now and`,
      '  naturally present when you flip this session to Build mode (same worktree).',
      '- This is a normal session: commit, test, and Finalize work exactly as usual.',
    ].join('\n'),
  );

  for (const project of opts.linkedProjects ?? []) {
    const docs = readProjectDesignDocs(project);
    if (docs) {
      sections.push(`## Design System — ${project.name}\n\n${docs}`);
    }
  }

  const files = listDesignModeFiles(opts.worktreePath, subdir);
  if (files.length > 0) {
    sections.push(
      `## Current files in \`${subdir}/\`\n\n${files.map((f) => `- ${subdir}/${f}`).join('\n')}`,
    );
  } else {
    sections.push(
      `## Current files in \`${subdir}/\`\n\n(empty — create \`${subdir}/index.html\` to start)`,
    );
  }

  return sections.join('\n\n').trim();
}

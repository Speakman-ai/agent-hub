import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildDesignModePreamble,
  listDesignModeFiles,
  readProjectDesignDocs,
  requiredSkillIdsForSession,
  ensureRealDesignDir,
  DESIGN_MODE_SUBDIR,
  DESIGN_SKILL_ID,
} from './design-mode-prompt.js';
import type { Project } from './types.js';

function makeProject(over: Partial<Project> = {}): Project {
  return { id: 'proj', name: 'Proj', ...(over as object) } as Project;
}

describe('listDesignModeFiles', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'design-mode-files-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('returns [] when the design subdir does not exist', () => {
    expect(listDesignModeFiles(work)).toEqual([]);
  });

  it('lists files recursively with forward-slash relative paths, sorted', () => {
    const root = path.join(work, DESIGN_MODE_SUBDIR);
    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    writeFileSync(path.join(root, 'styles.css'), 'body{}');
    writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg/>');
    expect(listDesignModeFiles(work)).toEqual(['assets/logo.svg', 'index.html', 'styles.css']);
  });

  it('skips symlinked files and does not follow symlinked directories (no escape/cycle)', () => {
    // A target tree OUTSIDE the design dir that must never appear in the listing.
    const outside = path.join(work, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'do not include');

    const root = path.join(work, DESIGN_MODE_SUBDIR);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    // Symlinked file pointing outside, and a symlinked dir pointing outside.
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-to-secret.txt'));
    symlinkSync(outside, path.join(root, 'escape-dir'));
    // Self-referential symlinked dir (a classic walk cycle) — must not hang.
    symlinkSync(root, path.join(root, 'self'));

    const files = listDesignModeFiles(work);
    expect(files).toEqual(['index.html']);
    expect(files.some((f) => f.includes('secret'))).toBe(false);
    expect(files.some((f) => f.includes('escape-dir'))).toBe(false);
    expect(files.some((f) => f.includes('self'))).toBe(false);
  });

  it('rejects a symlinked artifact root (no escape via a symlinked design/ dir)', () => {
    // The whole `design/` dir is a symlink pointing outside the worktree.
    const outside = path.join(work, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'do not include');
    writeFileSync(path.join(outside, 'index.html'), '<html></html>');

    symlinkSync(outside, path.join(work, DESIGN_MODE_SUBDIR));

    // Root is a symlink → reject outright, disclosing nothing from `outside`.
    expect(listDesignModeFiles(work)).toEqual([]);
  });
});

describe('ensureRealDesignDir', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'design-mode-ensure-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('creates a real design/ dir when none exists', () => {
    const res = ensureRealDesignDir(work);
    expect(res.dir).toBe(path.join(work, DESIGN_MODE_SUBDIR));
    expect(res.ok).toBe(true);
    expect(res.neutralizedSymlink).toBe(false);
    expect(lstatSync(res.dir).isDirectory()).toBe(true);
  });

  it('leaves an existing real design/ dir (and its files) intact', () => {
    const root = path.join(work, DESIGN_MODE_SUBDIR);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    const res = ensureRealDesignDir(work);
    expect(res.ok).toBe(true);
    expect(res.neutralizedSymlink).toBe(false);
    expect(readFileSync(path.join(root, 'index.html'), 'utf-8')).toBe('<html></html>');
  });

  it('reports ok:false when a non-directory (regular file) occupies the root', () => {
    // A regular file named `design` — NOT a symlink, so it is not removed; the
    // post-condition must report it as unusable rather than silently proceeding.
    writeFileSync(path.join(work, DESIGN_MODE_SUBDIR), 'i am a file, not a dir');
    const res = ensureRealDesignDir(work);
    expect(res.neutralizedSymlink).toBe(false);
    expect(res.ok).toBe(false);
    // The conflicting file is left intact (no destructive delete of real data).
    expect(lstatSync(res.dir).isFile()).toBe(true);
  });

  it('neutralizes a symlinked root: removes the link, creates a real dir, target untouched', () => {
    const outside = path.join(work, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'pre-existing.txt'), 'keep me');
    // design/ is a symlink pointing outside the worktree.
    symlinkSync(outside, path.join(work, DESIGN_MODE_SUBDIR));

    const res = ensureRealDesignDir(work);
    expect(res.neutralizedSymlink).toBe(true);
    expect(res.ok).toBe(true);

    // The artifact root is now a REAL directory, not a symlink.
    const st = lstatSync(res.dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);

    // A write into design/ now lands in the worktree, NOT the outside target.
    writeFileSync(path.join(res.dir, 'index.html'), 'in-worktree');
    expect(existsSync(path.join(outside, 'index.html'))).toBe(false);

    // The symlink target's own contents were never deleted.
    expect(readFileSync(path.join(outside, 'pre-existing.txt'), 'utf-8')).toBe('keep me');
  });
});

describe('readProjectDesignDocs', () => {
  let ahw: string;
  beforeEach(() => {
    ahw = mkdtempSync(path.join(tmpdir(), 'design-mode-docs-'));
  });
  afterEach(() => rmSync(ahw, { recursive: true, force: true }));

  it('prefers DESIGN_SYSTEM.md over SOUL.md', () => {
    writeFileSync(path.join(ahw, 'DESIGN_SYSTEM.md'), 'use the brand palette');
    writeFileSync(path.join(ahw, 'SOUL.md'), 'soul fallback');
    expect(readProjectDesignDocs(makeProject({ ahw }))).toBe('use the brand palette');
  });

  it('falls back to SOUL.md when no DESIGN_SYSTEM.md', () => {
    writeFileSync(path.join(ahw, 'SOUL.md'), 'soul fallback');
    expect(readProjectDesignDocs(makeProject({ ahw }))).toBe('soul fallback');
  });

  it('returns null when neither file exists', () => {
    expect(readProjectDesignDocs(makeProject({ ahw }))).toBeNull();
  });

  it('returns null when the project has no workspace path', () => {
    expect(readProjectDesignDocs(makeProject())).toBeNull();
  });
});

describe('requiredSkillIdsForSession', () => {
  it('force-loads the design skill only when session_mode is design', () => {
    expect(requiredSkillIdsForSession({ session_mode: 'design' })).toEqual([DESIGN_SKILL_ID]);
  });

  it('loads nothing for chat / default / missing mode', () => {
    expect(requiredSkillIdsForSession({ session_mode: 'chat' })).toEqual([]);
    expect(requiredSkillIdsForSession({ session_mode: null })).toEqual([]);
    expect(requiredSkillIdsForSession({})).toEqual([]);
    expect(requiredSkillIdsForSession(null)).toEqual([]);
  });

  it('uses the canonical normalization — non-exact values do not activate', () => {
    // Mirrors session-mode.ts: only the exact canonical 'design' is design mode.
    expect(requiredSkillIdsForSession({ session_mode: 'DESIGN' })).toEqual([]);
    expect(requiredSkillIdsForSession({ session_mode: ' design ' })).toEqual([]);
    expect(requiredSkillIdsForSession({ session_mode: 'designs' })).toEqual([]);
  });
});

describe('buildDesignModePreamble', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'design-mode-preamble-'));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('always includes the Design Mode header and design/ artifact instruction', () => {
    const out = buildDesignModePreamble({ worktreePath: work });
    expect(out).toContain('## Design Mode');
    expect(out).toContain('`design/`');
    expect(out).toContain('design/index.html');
  });

  it('reports an empty design dir', () => {
    const out = buildDesignModePreamble({ worktreePath: work });
    expect(out).toMatch(/empty — create `design\/index\.html`/);
  });

  it('lists current design files when present', () => {
    const root = path.join(work, DESIGN_MODE_SUBDIR);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    const out = buildDesignModePreamble({ worktreePath: work });
    expect(out).toContain('## Current files in `design/`');
    expect(out).toContain('- design/index.html');
  });

  it('includes linked-project design-system docs', () => {
    const ahw = mkdtempSync(path.join(tmpdir(), 'design-mode-proj-'));
    writeFileSync(path.join(ahw, 'DESIGN_SYSTEM.md'), 'brand palette: indigo');
    const out = buildDesignModePreamble({
      worktreePath: work,
      linkedProjects: [makeProject({ name: 'Acme', ahw })],
    });
    expect(out).toContain('## Design System — Acme');
    expect(out).toContain('brand palette: indigo');
    rmSync(ahw, { recursive: true, force: true });
  });

  it('honours a custom subdir', () => {
    const out = buildDesignModePreamble({ worktreePath: work, subdir: 'mockups' });
    expect(out).toContain('`mockups/`');
    expect(out).toContain('mockups/index.html');
  });

  it('surfaces an error + recovery path when the artifact dir is not ready', () => {
    const out = buildDesignModePreamble({ worktreePath: work, artifactDirReady: false });
    // Clear error header + actionable recovery, NOT the normal write instructions.
    expect(out).toContain('artifact directory unavailable');
    expect(out).toContain('Do not write any design files yet');
    expect(out).toMatch(/ls -la design/);
    expect(out).toMatch(/git rm design/);
    // Must not blindly instruct writing into the impossible path.
    expect(out).not.toContain('Build self-contained HTML/CSS/JS');
    expect(out).not.toContain('The live canvas renders this file');
  });

  it('explains design mode is unavailable when there is no session worktree', () => {
    const out = buildDesignModePreamble({ worktreePath: '', worktreeAvailable: false });
    expect(out).toContain('unavailable (no session worktree)');
    expect(out).toContain('Do not create');
    // Not the normal write instructions, and not the blocked-dir recovery text.
    expect(out).not.toContain('Build self-contained HTML/CSS/JS');
    expect(out).not.toContain('artifact directory unavailable');
    expect(out).not.toMatch(/ls -la design/);
  });

  it('no-worktree state takes precedence over a blocked artifact dir', () => {
    const out = buildDesignModePreamble({
      worktreePath: '',
      worktreeAvailable: false,
      artifactDirReady: false,
    });
    expect(out).toContain('unavailable (no session worktree)');
    expect(out).not.toContain('artifact directory unavailable');
  });

  it('still includes linked-project design docs in the blocked preamble', () => {
    const ahw = mkdtempSync(path.join(tmpdir(), 'design-mode-proj-blocked-'));
    writeFileSync(path.join(ahw, 'DESIGN_SYSTEM.md'), 'brand palette: indigo');
    const out = buildDesignModePreamble({
      worktreePath: work,
      artifactDirReady: false,
      linkedProjects: [makeProject({ name: 'Acme', ahw })],
    });
    expect(out).toContain('artifact directory unavailable');
    expect(out).toContain('## Design System — Acme');
    rmSync(ahw, { recursive: true, force: true });
  });
});

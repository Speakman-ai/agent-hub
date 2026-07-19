import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { augmentChatTurnForDesignMode } from './chat.js';
import type { Project, Stmts } from './types.js';

/**
 * Integration-style coverage for the design-mode spawn wiring (the chat-handler
 * path), not just the pure helpers. `augmentChatTurnForDesignMode` IS the logic
 * the streaming handler runs for a `session_mode='design'` turn — it is exported
 * for exactly this reason (mirrors `augmentChatTurnForSlashSkill`).
 *
 * These tests would fail if the chat path stopped force-loading the `design`
 * skill (e.g. regressed to relying on the message router, which returns [] when
 * the user message carries an explicit <agenthub:skill> block) or stopped
 * attaching the preamble.
 */
function writeSkill(skillsRoot: string, id: string, body: string) {
  const d = path.join(skillsRoot, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'SKILL.md'), body);
}

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-design-'));
  const skillsRoot = path.join(tmp, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  writeSkill(skillsRoot, 'design', '---\nname: design\n---\n# Design\nAuthor HTML/CSS/JS.');
  const worktree = path.join(tmp, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const project = { id: 'p1', name: 'Acme', cwd: worktree, ahw: tmp } as Project;
  const broadcast = vi.fn();
  const invocations: unknown[][] = [];
  const stmts = {
    insertSkillInvocation: { run: (...args: unknown[]) => invocations.push(args) },
  } as unknown as Stmts;
  return { tmp, skillsRoot, worktree, project, broadcast, invocations, stmts };
}

describe('augmentChatTurnForDesignMode (design-mode spawn wiring)', () => {
  it('force-loads the design skill AND prepends the preamble for a design session', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-1',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });

      // Skill force-loaded by id — independent of any message/router input.
      expect(out.skillInjections).toHaveLength(1);
      expect(out.skillInjections[0]).toContain('## Loaded Skill: design');
      expect(out.skillInjections[0]).toContain('Author HTML/CSS/JS.');
      expect(invocations).toHaveLength(1);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'skill_invocation', skill_id: 'design', status: 'loaded' }),
      );

      // Preamble attached and worktree-aware.
      expect(out.preamble).toContain('## Design Mode');
      expect(out.preamble).toContain('`design/`');

      // The design/ artifact dir is ensured in the worktree.
      expect(existsSync(path.join(worktree, 'design'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still force-loads the skill even when another skill was explicitly invoked (router-independent)', () => {
    // The reviewer scenario: an explicit <agenthub:skill> block makes the router
    // return []. Because the force-load is by id (not via the router), the design
    // skill must still load. This function takes no message — proving it.
    const { tmp, skillsRoot, worktree, project, broadcast, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-2',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
        // Simulate the router/pending set already containing an UNRELATED skill.
        alreadyLoadedSkillIds: new Set(['kanban']),
      });
      expect(out.skillInjections).toHaveLength(1);
      expect(out.skillInjections[0]).toContain('## Loaded Skill: design');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not double-load when the design skill is already in the dedupe set', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-3',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
        alreadyLoadedSkillIds: new Set(['design']),
      });
      expect(out.skillInjections).toHaveLength(0);
      expect(invocations).toHaveLength(0);
      // Preamble is still attached regardless of skill dedupe.
      expect(out.preamble).toContain('## Design Mode');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips the skill load on auto-continuations but still attaches the preamble', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-4',
        stmts,
        broadcast,
        loadSkills: false,
        dataDir: tmp,
      });
      expect(out.skillInjections).toHaveLength(0);
      expect(invocations).toHaveLength(0);
      expect(out.preamble).toContain('## Design Mode');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('neutralizes a symlinked design/ root before instructing the agent to write there', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, stmts } = setup();
    try {
      // The worktree already contains `design -> /outside` (committed/planted).
      const outside = path.join(tmp, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'keep.txt'), 'keep me');
      symlinkSync(outside, path.join(worktree, 'design'));

      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-symlink',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });

      // design/ is now a REAL dir in the worktree, not a symlink-out.
      const st = lstatSync(path.join(worktree, 'design'));
      expect(st.isDirectory()).toBe(true);
      expect(st.isSymbolicLink()).toBe(false);

      // A write to design/index.html now stays in the checkout, not /outside.
      writeFileSync(path.join(worktree, 'design', 'index.html'), 'in-worktree');
      expect(existsSync(path.join(outside, 'index.html'))).toBe(false);
      // The symlink target's contents were never deleted.
      expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);

      // Preamble still attached as normal.
      expect(out.preamble).toContain('## Design Mode');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces a blocked artifact dir (non-directory entry) instead of write instructions', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, stmts } = setup();
    try {
      // A regular FILE named `design` blocks the artifact dir in the worktree.
      writeFileSync(path.join(worktree, 'design'), 'i am a file, not a dir');

      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-blocked',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });

      // The post-condition is surfaced, not ignored.
      expect(out.artifactDirReady).toBe(false);
      // Preamble carries the error + recovery path, NOT "write index.html here".
      expect(out.preamble).toContain('artifact directory unavailable');
      expect(out.preamble).toContain('Do not write any design files yet');
      expect(out.preamble).not.toContain('Build self-contained HTML/CSS/JS');
      // The blocking file is left intact (no silent destructive delete).
      expect(lstatSync(path.join(worktree, 'design')).isFile()).toBe(true);
      // The design skill is still force-loaded so the agent has its rules.
      expect(out.skillInjections).toHaveLength(1);
      expect(out.skillInjections[0]).toContain('## Loaded Skill: design');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports artifactDirReady:true on a healthy design turn', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-ready',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });
      expect(out.artifactDirReady).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('disables design mode (no skill, no dir, explanatory preamble) when the session has no worktree', () => {
    const { tmp, skillsRoot, project, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: null },
        project, // project.cwd is the temp dir — must NOT be polluted
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-no-wt',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });

      // Design behavior is disabled: no skill load, post-condition surfaced.
      expect(out.skillInjections).toHaveLength(0);
      expect(invocations).toHaveLength(0);
      expect(out.artifactDirReady).toBe(false);
      // Preamble explains the mode is unavailable rather than instructing writes.
      expect(out.preamble).toContain('unavailable (no session worktree)');
      expect(out.preamble).not.toContain('Build self-contained HTML/CSS/JS');
      // Crucially: the shared project checkout was NOT polluted with design/.
      expect(existsSync(path.join(project.cwd as string, 'design'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs design mode for a WORKFLOW (no-code) project with no worktree, using the data-dir store', () => {
    const { tmp, skillsRoot, project, broadcast, invocations, stmts } = setup();
    try {
      // Workflow projects have no per-session worktree; artifacts go to the
      // Hub data-dir store instead of `<worktree>/design`.
      const workflowProject = { ...project, mode: 'workflow' } as Project;
      const dataDir = path.join(tmp, 'data');
      mkdirSync(dataDir, { recursive: true });
      const sessionId = 'sess-workflow';

      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: null },
        project: workflowProject,
        paths: { skillsDir: skillsRoot },
        sessionId,
        stmts,
        broadcast,
        loadSkills: true,
        dataDir,
      });

      // Design behavior is ACTIVE (unlike a dev project with no worktree).
      expect(out.skillInjections).toHaveLength(1);
      expect(out.skillInjections[0]).toContain('## Loaded Skill: design');
      expect(invocations).toHaveLength(1);
      expect(out.artifactDirReady).toBe(true);

      // The store dir is created under <dataDir>/design-sessions/<sessionId>.
      const storeRoot = path.join(dataDir, 'design-sessions', sessionId);
      expect(existsSync(storeRoot)).toBe(true);

      // Preamble is the no-code variant: points at the absolute store path and
      // omits the worktree/Build-handoff language.
      expect(out.preamble).toContain('## Design Mode');
      expect(out.preamble).toContain('no-code');
      expect(out.preamble).toContain(storeRoot);
      expect(out.preamble).not.toContain('unavailable (no session worktree)');
      // The shared project checkout is NOT polluted with a design/ dir.
      expect(existsSync(path.join(workflowProject.cwd as string, 'design'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces a blocked data-dir store (non-directory entry) for a workflow project', () => {
    const { tmp, skillsRoot, project, broadcast, stmts } = setup();
    try {
      const workflowProject = { ...project, mode: 'workflow' } as Project;
      const dataDir = path.join(tmp, 'data');
      const sessionId = 'sess-workflow-blocked';
      // A regular FILE occupies the store path so the dir can't be created.
      mkdirSync(path.join(dataDir, 'design-sessions'), { recursive: true });
      writeFileSync(path.join(dataDir, 'design-sessions', sessionId), 'not a dir');

      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'design', worktree_path: null },
        project: workflowProject,
        paths: { skillsDir: skillsRoot },
        sessionId,
        stmts,
        broadcast,
        loadSkills: true,
        dataDir,
      });

      expect(out.artifactDirReady).toBe(false);
      expect(out.preamble).toContain('artifact directory unavailable');
      expect(out.preamble).not.toContain('no-code project. Build');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is a no-op for a non-design (chat) session', () => {
    const { tmp, skillsRoot, worktree, project, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForDesignMode({
        session: { session_mode: 'chat', worktree_path: worktree },
        project,
        paths: { skillsDir: skillsRoot },
        sessionId: 'sess-5',
        stmts,
        broadcast,
        loadSkills: true,
        dataDir: tmp,
      });
      expect(out.skillInjections).toHaveLength(0);
      expect(out.preamble).toBe('');
      expect(invocations).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

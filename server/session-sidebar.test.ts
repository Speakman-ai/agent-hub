import { describe, it, expect } from 'vitest';
import {
  buildSidebarSeedContext,
  claudeSidebarForkArgs,
  createSidebarBroadcastTagger,
  isSidebarSession,
  sidebarForkSource,
  sidebarSpawnCwd,
} from './session-sidebar.js';
import { buildConsultModePreamble } from './consult-mode-prompt.js';

describe('sidebarForkSource', () => {
  it('forks a Claude Code parent that has a CLI session', () => {
    expect(sidebarForkSource({ engine: 'claude-code', engine_session_id: 'abc' })).toBe('abc');
  });

  it('falls back to a seed for other engines or a parent with no CLI session', () => {
    expect(sidebarForkSource({ engine: 'cursor-agent', engine_session_id: 'abc' })).toBeNull();
    expect(sidebarForkSource({ engine: 'claude-code', engine_session_id: null })).toBeNull();
    expect(sidebarForkSource({ engine: 'claude-code', engine_session_id: '  ' })).toBeNull();
  });
});

describe('claudeSidebarForkArgs', () => {
  it('resumes the parent with --fork-session under the SideBar id', () => {
    expect(claudeSidebarForkArgs('parent-cli', 'sidebar-id')).toEqual([
      '--resume',
      'parent-cli',
      '--fork-session',
      '--session-id',
      'sidebar-id',
    ]);
  });
});

describe('sidebarSpawnCwd', () => {
  it("uses the parent's worktree so the fork finds the parent conversation", () => {
    expect(sidebarSpawnCwd({ worktree_path: '/ws/session-1' }, '/proj')).toBe('/ws/session-1');
  });

  it('falls back to the project checkout', () => {
    expect(sidebarSpawnCwd({ worktree_path: null }, '/proj')).toBe('/proj');
    expect(sidebarSpawnCwd(undefined, '/proj')).toBe('/proj');
  });
});

describe('isSidebarSession', () => {
  it('keys off sidebar_parent_id', () => {
    expect(isSidebarSession({ sidebar_parent_id: 'p' })).toBe(true);
    expect(isSidebarSession({ sidebar_parent_id: null })).toBe(false);
    expect(isSidebarSession(undefined)).toBe(false);
  });
});

describe('buildSidebarSeedContext', () => {
  it('labels user and assistant turns and skips system rows', () => {
    const out = buildSidebarSeedContext(
      [
        { role: 'user', content: 'fix the bug' },
        { role: 'system', content: 'Finalize started' },
        { role: 'assistant', content: 'done' },
      ],
      { agentName: 'Dev' },
    );
    expect(out).toContain('[User]:\nfix the bug');
    expect(out).toContain('[Dev]:\ndone');
    expect(out).not.toContain('Finalize started');
    expect(out).not.toContain('omitted');
  });

  it('keeps the newest messages under the byte cap', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `msg-${i} ${'x'.repeat(100)}`,
    }));
    const out = buildSidebarSeedContext(messages, { agentName: 'Dev', maxBytes: 350 });
    expect(out).toContain('msg-9');
    expect(out).not.toContain('msg-0 ');
    expect(out).toMatch(/\(\d+ older message\(s\) omitted\.\)/);
  });

  it('says so when the parent has no messages', () => {
    expect(buildSidebarSeedContext([], { agentName: 'Dev' })).toContain('no messages yet');
  });
});

describe('buildConsultModePreamble sidebar', () => {
  const project = { id: 'p', name: 'P', mode: 'dev' as const };

  it('points code changes at the main session instead of Build mode', () => {
    const out = buildConsultModePreamble({ project, sidebar: true });
    expect(out).toContain('### SideBar');
    expect(out).toContain('ask for it in the main session');
    expect(out).not.toContain('switch this session to **Build**');
  });

  it('is unchanged for a standalone Consult session', () => {
    const out = buildConsultModePreamble({ project });
    expect(out).not.toContain('### SideBar');
    expect(out).toContain('switch this session to **Build**');
  });
});

describe('createSidebarBroadcastTagger', () => {
  const parents: Record<string, string | null> = { sb: 'main', main: null };

  it('tags events about a SideBar session with its parent', () => {
    const tag = createSidebarBroadcastTagger((id) => parents[id] ?? null);
    expect(tag({ type: 'stream', sessionId: 'sb' })).toEqual({
      type: 'stream',
      sessionId: 'sb',
      sidebarParentId: 'main',
    });
    expect(tag({ type: 'message', message: { session_id: 'sb' } }).sidebarParentId).toBe('main');
  });

  it('leaves other events untouched', () => {
    const tag = createSidebarBroadcastTagger((id) => parents[id] ?? null);
    const ev = { type: 'stream', sessionId: 'main' };
    expect(tag(ev)).toBe(ev);
    const global = { type: 'kanban_update' };
    expect(tag(global)).toBe(global);
  });

  it('looks each session up once', () => {
    let calls = 0;
    const tag = createSidebarBroadcastTagger((id) => {
      calls++;
      return parents[id] ?? null;
    });
    for (let i = 0; i < 5; i++) {
      tag({ type: 'stream', sessionId: 'sb' });
      tag({ type: 'stream', sessionId: 'main' });
    }
    expect(calls).toBe(2);
  });
});

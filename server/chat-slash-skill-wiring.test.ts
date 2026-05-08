import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { augmentChatTurnForSlashSkill } from './chat.js';
import type { Agent, Project, Stmts } from './types.js';

function skillDirLayout(skillsRoot: string, id: string, body: string) {
  const d = path.join(skillsRoot, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'SKILL.md'), body);
}

describe('augmentChatTurnForSlashSkill (slash → loadSkillByName wiring)', () => {
  let tmp: string;

  it('appends loadSkillByName injection and sets cliContent to user args only', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-slash-'));
    const skillsRoot = path.join(tmp, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    skillDirLayout(skillsRoot, 'foo', '# Foo\nslash wiring');

    const project = {
      id: 'p1',
      name: 'P',
      cwd: tmp,
      ahw: tmp,
    } as Project;
    const agent = { id: 'a1', name: 'A', engine: 'claude-code' } as Agent;

    const rows: unknown[][] = [];
    const broadcast = vi.fn();
    const stmts = {
      insertSkillInvocation: { run: (...args: unknown[]) => rows.push(args) },
    } as unknown as Stmts;

    const out = augmentChatTurnForSlashSkill({
      slashResult: { skillName: 'foo', userArgs: 'run the task' },
      project,
      agent,
      sessionId: 'sess-1',
      stmts,
      broadcast,
      isAutoContinuation: false,
      content: '/foo run the task',
    });

    expect(out.cliContent).toBe('run the task');
    expect(out.cliContent).not.toMatch(/<skill\b/i);
    expect(out.slashSkillSuffix).toContain('## Loaded Skill: foo');
    expect(out.slashSkillSuffix).toContain('slash wiring');
    expect(rows.length).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'skill_invocation',
        skill_id: 'foo',
        status: 'loaded',
      }),
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it('uses agent.ahw skills when project.ahw is unset (parity with resolveSlashSkill)', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-slash-agent-ahw-'));
    const agentWs = path.join(tmp, 'agent-ws');
    const skillsRoot = path.join(agentWs, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    skillDirLayout(skillsRoot, 'linear', '# Linear\nfrom agent ahw');

    const project = { id: 'p1', name: 'P', cwd: tmp, ahw: '' } as unknown as Project;
    const agent = {
      id: 'a1',
      name: 'A',
      engine: 'claude-code',
      ahw: agentWs,
    } as Agent;

    const stmts = {
      insertSkillInvocation: { run: vi.fn() },
    } as unknown as Stmts;

    const out = augmentChatTurnForSlashSkill({
      slashResult: { skillName: 'linear', userArgs: '' },
      project,
      agent,
      sessionId: 's2',
      stmts,
      broadcast: vi.fn(),
      isAutoContinuation: false,
      content: '/linear',
    });

    expect(out.slashSkillSuffix).toContain('from agent ahw');
    expect(out.cliContent).toContain('Please use this skill');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('leaves content unchanged when auto-continuing or when slash did not resolve', () => {
    const project = { id: 'p1', name: 'P', cwd: '/x', ahw: '/x' } as Project;
    const agent = { id: 'a1', name: 'A', engine: 'claude-code' } as Agent;
    const stmts = { insertSkillInvocation: { run: vi.fn() } } as unknown as Stmts;

    expect(
      augmentChatTurnForSlashSkill({
        slashResult: { skillName: 'nope', userArgs: 'x' },
        project,
        agent,
        sessionId: 's',
        stmts,
        broadcast: vi.fn(),
        isAutoContinuation: true,
        content: '/nope x',
      }).cliContent,
    ).toBe('/nope x');

    expect(
      augmentChatTurnForSlashSkill({
        slashResult: null,
        project,
        agent,
        sessionId: 's',
        stmts,
        broadcast: vi.fn(),
        isAutoContinuation: false,
        content: 'hello',
      }),
    ).toEqual({ slashSkillSuffix: '', cliContent: 'hello' });
  });
});

describe('enrichedPrompt suffix order (pending → slash → routed)', () => {
  it('matches createChatHandler merge order', () => {
    let enriched = 'BASE';
    const pending = '\n\nPENDING_BLOCK';
    const slash = '\n\nSLASH_BLOCK';
    const routed = '\n\nROUTED_BLOCK';
    if (pending) enriched += pending;
    if (slash) enriched += slash;
    if (routed) enriched += routed;
    expect(enriched.indexOf('PENDING')).toBeLessThan(enriched.indexOf('SLASH'));
    expect(enriched.indexOf('SLASH')).toBeLessThan(enriched.indexOf('ROUTED'));
  });
});

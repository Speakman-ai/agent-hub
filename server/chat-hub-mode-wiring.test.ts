import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { augmentChatTurnForHubMode } from './chat.js';
import type { Stmts } from './types.js';
import { HUB_SKILL_IDS } from './hub-mode-prompt.js';

function writeSkill(skillsRoot: string, id: string, body: string) {
  const d = path.join(skillsRoot, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'SKILL.md'), body);
}

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chat-hub-'));
  const skillsRoot = path.join(tmp, 'skills');
  mkdirSync(skillsRoot, { recursive: true });
  for (const id of HUB_SKILL_IDS) {
    writeSkill(skillsRoot, id, `---\nname: ${id}\n---\n# ${id}\nBody for ${id}.`);
  }
  const broadcast = vi.fn();
  const invocations: unknown[][] = [];
  const stmts = {
    insertSkillInvocation: { run: (...args: unknown[]) => invocations.push(args) },
  } as unknown as Stmts;
  return { tmp, skillsRoot, broadcast, invocations, stmts };
}

describe('augmentChatTurnForHubMode (hub-mode spawn wiring)', () => {
  it('force-loads agent-hub (and Hub siblings) and prepends the Hub preamble', () => {
    const { tmp, skillsRoot, broadcast, invocations, stmts } = setup();
    try {
      const out = augmentChatTurnForHubMode({
        session: { session_mode: 'hub' },
        paths: { skillsDir: skillsRoot },
        sessionId: 'hub-sess-1',
        stmts,
        broadcast,
        loadSkills: true,
      });

      expect(out.skillInjections).toHaveLength(HUB_SKILL_IDS.length);
      expect(out.skillInjections[0]).toContain('## Loaded Skill: agent-hub');
      expect(out.skillInjections[0]).toContain('Body for agent-hub.');
      expect(invocations).toHaveLength(HUB_SKILL_IDS.length);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'skill_invocation',
          skill_id: 'agent-hub',
          status: 'loaded',
        }),
      );
      expect(out.preamble).toContain('## Server Agent');
      expect(out.preamble).toContain("this user's Server Agent");
      // Acts with the owner's permissions, not the break-glass key.
      expect(out.preamble).toContain('their own token');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does nothing for non-hub sessions', () => {
    const { tmp, skillsRoot, broadcast, stmts } = setup();
    try {
      const out = augmentChatTurnForHubMode({
        session: { session_mode: 'chat' },
        paths: { skillsDir: skillsRoot },
        sessionId: 'hub-sess-2',
        stmts,
        broadcast,
        loadSkills: true,
      });
      expect(out.skillInjections).toHaveLength(0);
      expect(out.preamble).toBe('');
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips already-loaded skills but still attaches the preamble', () => {
    const { tmp, skillsRoot, invocations, stmts, broadcast } = setup();
    try {
      const out = augmentChatTurnForHubMode({
        session: { session_mode: 'hub' },
        paths: { skillsDir: skillsRoot },
        sessionId: 'hub-sess-3',
        stmts,
        broadcast,
        loadSkills: true,
        alreadyLoadedSkillIds: new Set(['agent-hub']),
      });
      expect(out.skillInjections.some((s) => /^## Loaded Skill: agent-hub$/m.test(s))).toBe(false);
      expect(out.skillInjections).toHaveLength(HUB_SKILL_IDS.length - 1);
      expect(invocations).toHaveLength(HUB_SKILL_IDS.length - 1);
      expect(out.preamble).toContain('## Server Agent');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loads every Agent Hub skill, including the wiki', () => {
    for (const id of [
      'agent-hub',
      'agent-hub-kanban',
      'agent-hub-sessions',
      'agent-hub-heartbeats-crons',
      'agent-hub-wiki',
    ]) {
      expect(HUB_SKILL_IDS).toContain(id);
    }
  });

  it("uses the owner's Server Agent name and instructions", () => {
    const { tmp, skillsRoot, broadcast, stmts } = setup();
    try {
      const out = augmentChatTurnForHubMode({
        session: { session_mode: 'hub' },
        paths: { skillsDir: skillsRoot },
        sessionId: 'hub-sess-4',
        stmts,
        broadcast,
        loadSkills: false,
        serverAgent: { name: 'Jarvis', instructions: 'Answer in one sentence.' },
      });
      expect(out.preamble).toContain('## Jarvis');
      expect(out.preamble).toContain('You are **Jarvis**');
      expect(out.preamble).toContain('### Instructions from the user');
      expect(out.preamble).toContain('Answer in one sentence.');
      // User instructions come after the built-in limits.
      expect(out.preamble.indexOf('Answer in one sentence.')).toBeGreaterThan(
        out.preamble.indexOf('### Hard limits'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * `buildEnrichedPrompt` — setup-wizard workspace-memory suppression.
 *
 * Guided setup-wizard sessions ([Preview Setup] / [Finalize Setup] /
 * [RUM Setup] / [Deploy Setup]) are single-task sessions whose kickoff prompt
 * is the sole authoritative instruction. They run in the agent's workspace, so
 * the first-turn memory carryover (MEMORY.md + today's daily note) lands in them
 * too — and that daily note can carry a "Session Summary (just completed)" block
 * from an UNRELATED dev effort.
 *
 * Documented failure: Preview Setup session a76feed4 ignored its wizard kickoff
 * and instead resumed an unrelated "Deputy timesheet mapping" dev task pulled
 * from the carried summary. This test reproduces the exact bleed vector and
 * locks in that `omitWorkspaceMemory` strips the carryover for wizard sessions
 * while normal sessions keep it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import type { EnrichedAgent } from './types.js';
import { localDateStr } from './memory.js';

const tmpBase = path.join(os.tmpdir(), `wizard-memory-test-${Date.now()}`);

vi.mock('./db.js', () => ({
  db: {},
  stmts: {
    getAgentSkillOverrides: { all: () => [] },
  },
}));

vi.mock('./wiki.js', () => ({
  getWikiContext: () => '',
}));

vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));

vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: () => ({
    skillsDir: path.join(tmpBase, 'skills'),
    contextFiles: {},
  }),
  contextFilePath: () => null,
}));

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: () => null,
}));

import { buildEnrichedPrompt } from './chat.js';

// The carried-over summary that bled into the preview-setup session. Its
// presence in today's daily note is the bug; its absence from a wizard prompt
// is the fix.
const BLEED_MARKER = 'Deputy timesheet mapping work from the session summary';
const MEMORY_MARKER = 'Long-term decision about the Foo subsystem';

beforeEach(() => {
  mkdirSync(path.join(tmpBase, 'memory'), { recursive: true });
  writeFileSync(path.join(tmpBase, 'MEMORY.md'), `# MEMORY.md\n\n${MEMORY_MARKER}\n`, 'utf-8');
  writeFileSync(
    path.join(tmpBase, 'memory', `${localDateStr()}.md`),
    `## 17:51\n**Session Summary (just completed)**\nI'll pick up the ${BLEED_MARKER}...\n`,
    'utf-8',
  );
});

afterAll(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-a',
    name: 'Project A',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alice',
    name: 'Alice',
    engine: 'claude-code',
    systemPrompt: 'You are Alice.',
    role: 'dev',
    ...overrides,
  } as unknown as EnrichedAgent;
}

describe('buildEnrichedPrompt — setup-wizard memory suppression', () => {
  it('injects workspace memory for a normal session (baseline / no regression)', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
    });
    // The carried summary AND long-term memory must be present for normal work.
    expect(prompt).toContain(BLEED_MARKER);
    expect(prompt).toContain(MEMORY_MARKER);
  });

  it('strips the workspace-memory carryover when omitWorkspaceMemory is set', () => {
    const prompt = buildEnrichedPrompt(makeProject() as never, makeAgent() as never, {
      isFirstMessage: true,
      omitWorkspaceMemory: true,
    });
    // This is the bug fix: the unrelated "Deputy timesheet" summary must NOT
    // reach a focused wizard session, and neither should long-term memory.
    expect(prompt).not.toContain(BLEED_MARKER);
    expect(prompt).not.toContain(MEMORY_MARKER);
    expect(prompt).not.toContain("## Today's Notes");
    expect(prompt).not.toContain('## MEMORY.md (Long-term)');
  });
});

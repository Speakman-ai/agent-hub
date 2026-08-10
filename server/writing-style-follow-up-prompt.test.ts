/**
 * Regression coverage for: "I asked a very simple question and you gave me a
 * research paper's worth of explanation."
 *
 * Two defects produced that:
 *
 *  1. The whole `## Writing Style: No AI Slop` block was gated behind
 *     `isFirstMessage`. Because `--system-prompt-file` is rebuilt and re-sent
 *     on every turn (including `--resume`), turn 2 onward carried *no* style
 *     contract at all. Short follow-up questions are exactly the turns that
 *     blew up, and they are exactly the turns that had no rules.
 *  2. Nothing anywhere tied answer length to question scope, so an agent that
 *     had done a lot of work reported all of it regardless of what was asked.
 *
 * These tests fail against the pre-fix prompt builder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

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

const tmpBase = path.join(os.tmpdir(), `writing-style-followup-${Date.now()}`);

vi.mock('./project-paths.js', () => ({
  resolveProjectPaths: () => ({
    skillsDir: path.join(tmpBase, 'skills'),
    contextFiles: {},
  }),
  contextFilePath: (_paths: unknown, filename: string) => {
    const p = path.join(tmpBase, filename);
    return existsSync(p) ? p : null;
  },
}));

vi.mock('./project-model.js', () => ({
  allAgents: () => [],
  findProject: () => null,
}));

import { buildEnrichedPrompt } from './chat.js';
import {
  ANSWER_SCALE_RULE,
  WRITING_STYLE_BLOCK,
  WRITING_STYLE_FOLLOW_UP_BLOCK,
} from './writing-style-prompt.js';

function makeProject(overrides = {}) {
  return {
    id: 'test-proj',
    name: 'Test Project',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  };
}

function makeAgent(overrides = {}) {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    engine: 'claude-code',
    systemPrompt: 'You are a test agent.',
    role: 'member' as const,
    ...overrides,
  };
}

describe('writing-style prompt blocks', () => {
  beforeEach(() => {
    mkdirSync(path.join(tmpBase, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('answer-scale rule', () => {
    it('ships in both the full and the follow-up variant, worded identically', () => {
      expect(WRITING_STYLE_BLOCK).toContain(ANSWER_SCALE_RULE);
      expect(WRITING_STYLE_FOLLOW_UP_BLOCK).toContain(ANSWER_SCALE_RULE);
    });

    it('tells the agent to size the answer to the question and lead with the conclusion', () => {
      expect(ANSWER_SCALE_RULE).toMatch(/yes\/no question gets yes or no in the first line/i);
      expect(ANSWER_SCALE_RULE).toMatch(/one-line question gets a one-line answer/i);
      expect(ANSWER_SCALE_RULE).toMatch(/lead with the conclusion/i);
    });

    it('forbids pasting tool output and subagent reports into chat', () => {
      expect(ANSWER_SCALE_RULE).toMatch(/never paste tool output/i);
      expect(ANSWER_SCALE_RULE).toMatch(/subagent reports/i);
      expect(ANSWER_SCALE_RULE).toMatch(/file:line/);
    });

    it('decouples answer length from how much work the answer took', () => {
      expect(WRITING_STYLE_BLOCK).toMatch(/no bearing on how long it should be/i);
    });
  });

  describe('follow-up turns', () => {
    it('carries the style contract on every turn after the first', () => {
      const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: false,
      });
      expect(prompt).toContain('## Writing Style (reminder)');
      expect(prompt).toContain(ANSWER_SCALE_RULE);
    });

    it('still keeps the load-bearing slop rules that used to vanish after turn 1', () => {
      const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: false,
      });
      expect(prompt).toMatch(/no preambles, recaps, hedges/i);
      expect(prompt).toMatch(/em\/en-dashes/i);
      expect(prompt).toMatch(/system-reminder/i);
      expect(prompt).toMatch(/never surface them/i);
    });

    it('sends the reminder instead of the full block, so the token trim survives', () => {
      const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: false,
      });
      expect(prompt).not.toContain('No AI Slop');
      // The reminder must stay a reminder: a large chunk of prose re-added to
      // every turn is the regression this guards against.
      expect(WRITING_STYLE_FOLLOW_UP_BLOCK.length).toBeLessThan(WRITING_STYLE_BLOCK.length / 2);
    });
  });

  describe('first turn', () => {
    it('sends the full block and not the reminder', () => {
      const prompt = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: true,
      });
      expect(prompt).toContain('No AI Slop');
      expect(prompt).toContain(ANSWER_SCALE_RULE);
      expect(prompt).not.toContain('## Writing Style (reminder)');
    });
  });
});

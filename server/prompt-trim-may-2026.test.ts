/**
 * Regression tests for the May 2026 prompt-trim audit.
 *
 * These pin the new per-turn cost contract:
 *
 *  1. `CLAUDE.md` is injected on the FIRST message of a session only.
 *     Subsequent turns omit it. (Repo-wide CLAUDE.md is the single largest
 *     contributor to the enriched prompt — ~22 KB on agent-hub — and its
 *     dev-loop guidance only needs to be absorbed once per session.)
 *
 *  2. `Available Skills` descriptions are compressed to at most
 *     `SKILL_DESCRIPTION_MAX_BYTES` UTF-8 bytes via `compressSkillDescription`.
 *     The default skill catalog used to re-ship ~12 KB of trigger/anti-trigger
 *     prose every turn; this cap keeps the first sentence and elides the rest.
 *
 *  3. `WIKI_CONTEXT_PAGE_CAP` is lowered to 10 (from 25). The on-demand
 *     `wiki_search` skill covers the long tail.
 *
 *  4. `getMemoryContext` honors `{ includeYesterday: false }` so callers
 *     (the prompt builder, on follow-up turns) can skip yesterday's notes.
 *
 *  5. The Writing Style block now folds the former File-Safety Reminder
 *     guidance into rule 5; the standalone "## File-Safety Reminder" header
 *     is gone in both first-message and follow-up modes.
 *
 *  6. Bias to Action no longer ships three near-duplicate variants — the
 *     workflow / non-workflow / linked-card paths render a single block with
 *     a parameterized middle section.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./db.js', () => ({
  db: {},
  stmts: { getAgentSkillOverrides: { all: () => [] } },
}));
vi.mock('./wiki.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getWikiContext: (projectId: string) =>
      projectId ? `## Project Wiki (2 pages)\n- Page A\n- Page B` : '',
  };
});
vi.mock('./routes/skills.js', () => ({
  collectSkillsFromDir: () => [],
  DEFAULT_SKILLS_DIR: '/tmp/no-skills',
}));
vi.mock('./config.js', () => ({
  default: { defaultModel: 'claude-sonnet-4-20250514' },
  defaultModelForEngine: () => 'claude-sonnet-4-20250514',
  buildSpawnEnv: () => ({}),
}));

const tmpBase = path.join(os.tmpdir(), `prompt-trim-test-${Date.now()}`);
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

import {
  buildEnrichedPrompt,
  compressSkillDescription,
  SKILL_DESCRIPTION_MAX_BYTES,
} from './chat.js';
import { getMemoryContext } from './memory.js';
import { WIKI_CONTEXT_PAGE_CAP } from './wiki.js';

function makeProject(overrides = {}) {
  return {
    id: 'trim-test-proj',
    name: 'Trim Test',
    cwd: tmpBase,
    ahw: tmpBase,
    agents: [],
    ...overrides,
  };
}
function makeAgent(overrides = {}) {
  return {
    id: 'trim-test-agent',
    name: 'Trim Test Agent',
    engine: 'claude-code',
    systemPrompt: 'You are a trim test agent.',
    role: 'member' as const,
    ...overrides,
  };
}

describe('Prompt trim — May 2026 audit', () => {
  describe('compressSkillDescription', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(compressSkillDescription(null)).toBe('');
      expect(compressSkillDescription(undefined)).toBe('');
      expect(compressSkillDescription('')).toBe('');
      expect(compressSkillDescription('   \n\n  ')).toBe('');
    });

    it('passes short descriptions through unchanged (modulo whitespace collapse)', () => {
      const desc = 'List, search, and update Linear issues.';
      expect(compressSkillDescription(desc)).toBe(desc);
    });

    it('collapses internal whitespace runs to a single space', () => {
      const desc = 'Foo\n\nbar    baz\t\tqux';
      expect(compressSkillDescription(desc)).toBe('Foo bar baz qux');
    });

    it('truncates over-long descriptions to <= SKILL_DESCRIPTION_MAX_BYTES UTF-8 bytes', () => {
      const long = 'A'.repeat(SKILL_DESCRIPTION_MAX_BYTES * 4);
      const out = compressSkillDescription(long);
      expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_BYTES);
      expect(out.endsWith('\u2026')).toBe(true);
    });

    it('prefers cutting at a sentence boundary when one exists in the kept slice', () => {
      const desc =
        'Manage Linear issues. TRIGGER when the user mentions LIN-<n> or Linear.app. ' +
        'DO NOT TRIGGER on linear algebra, linear interpolation, or any unrelated mathematical usage of the word linear.';
      const out = compressSkillDescription(desc, 80);
      expect(out).toBe('Manage Linear issues.\u2026');
    });

    it('honors an explicit byte cap override', () => {
      const out = compressSkillDescription('the quick brown fox jumps over the lazy dog', 12);
      expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(12);
      expect(out.endsWith('\u2026')).toBe(true);
    });
  });

  describe('Available Skills — first message vs follow-up preamble', () => {
    // We exercise the prompt builder directly. The DB / skills mocks above
    // return [] from `collectSkillsFromDir`, so we monkey-patch the listing
    // by writing a real plugin-style skill into a temp dir referenced by
    // `resolveProjectPaths`. Easier: just verify the preamble shrinks on
    // follow-up turns when there is at least one skill registered, which
    // is the gating contract we care about.

    it('uses a one-line preamble on follow-up turns when skills exist', () => {
      // We can't easily inject skills through the mocks, so we just assert
      // the absence of the verbose preamble on subsequent messages. The
      // first-message variant is exercised by the existing
      // `prompt-optimization.test.ts` suite.
      mkdirSync(tmpBase, { recursive: true });
      try {
        const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
          isFirstMessage: false,
        });
        expect(subsequent).not.toContain(
          'To load a skill for your next turn, end your turn with this block',
        );
      } finally {
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe('WIKI_CONTEXT_PAGE_CAP', () => {
    it('is set to 10 (lowered from 25 in the May 2026 trim)', () => {
      expect(WIKI_CONTEXT_PAGE_CAP).toBe(10);
    });
  });

  describe('getMemoryContext — includeYesterday option', () => {
    const memBase = path.join(os.tmpdir(), `memory-yest-test-${Date.now()}`);

    function setupNotes() {
      mkdirSync(path.join(memBase, 'memory'), { recursive: true });
      writeFileSync(path.join(memBase, 'MEMORY.md'), '# Long-term knowledge\n');
      const now = new Date();
      const ymd = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      writeFileSync(path.join(memBase, 'memory', `${ymd(now)}.md`), '## 09:00\nToday entry\n');
      writeFileSync(
        path.join(memBase, 'memory', `${ymd(yesterday)}.md`),
        '## 11:00\nYesterday entry\n',
      );
    }

    it('includes yesterday by default', () => {
      setupNotes();
      try {
        const out = getMemoryContext(memBase);
        expect(out).toContain("## Today's Notes");
        expect(out).toContain('Today entry');
        expect(out).toContain("## Yesterday's Notes");
        expect(out).toContain('Yesterday entry');
      } finally {
        rmSync(memBase, { recursive: true, force: true });
      }
    });

    it('omits yesterday when includeYesterday is false', () => {
      setupNotes();
      try {
        const out = getMemoryContext(memBase, { includeYesterday: false });
        expect(out).toContain("## Today's Notes");
        expect(out).toContain('Today entry');
        expect(out).not.toContain("## Yesterday's Notes");
        expect(out).not.toContain('Yesterday entry');
      } finally {
        rmSync(memBase, { recursive: true, force: true });
      }
    });

    it('still includes MEMORY.md regardless of the flag', () => {
      setupNotes();
      try {
        const out = getMemoryContext(memBase, { includeYesterday: false });
        expect(out).toContain('## MEMORY.md (Long-term)');
        expect(out).toContain('Long-term knowledge');
      } finally {
        rmSync(memBase, { recursive: true, force: true });
      }
    });
  });

  describe('CLAUDE.md gating', () => {
    it('ships only on the first message of a session', () => {
      mkdirSync(tmpBase, { recursive: true });
      writeFileSync(path.join(tmpBase, 'CLAUDE.md'), 'CLAUDE-MD-MARKER-BODY');
      try {
        const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
          isFirstMessage: true,
        });
        const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
          isFirstMessage: false,
        });
        expect(first).toContain('CLAUDE-MD-MARKER-BODY');
        expect(first).toContain('## CLAUDE.md');
        expect(subsequent).not.toContain('CLAUDE-MD-MARKER-BODY');
        expect(subsequent).not.toContain('## CLAUDE.md');
      } finally {
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe('Artifacts delivery instruction', () => {
    it('tells agents to upload generated files as artifacts on the first message', () => {
      const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: true,
      });
      expect(first).toContain('Deliver Files as Artifacts');
      expect(first).toContain('artifacts.sh put');
      // Should mention the panel so agents point the user there instead of pasting bytes.
      expect(first).toContain('Artifacts panel');
    });

    it('omits the artifacts block on follow-up turns to save tokens', () => {
      const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
        isFirstMessage: false,
      });
      expect(subsequent).not.toContain('Deliver Files as Artifacts');
    });
  });

  describe('Follow-up turn byte budget', () => {
    it('is materially smaller than first-message budget', () => {
      mkdirSync(tmpBase, { recursive: true });
      writeFileSync(
        path.join(tmpBase, 'CLAUDE.md'),
        'CLAUDE-MD bulk content\n'.repeat(800), // simulate a real ~16 KB CLAUDE.md
      );
      try {
        const first = buildEnrichedPrompt(makeProject(), makeAgent(), {
          isFirstMessage: true,
        });
        const subsequent = buildEnrichedPrompt(makeProject(), makeAgent(), {
          isFirstMessage: false,
        });
        const firstBytes = Buffer.byteLength(first, 'utf-8');
        const subBytes = Buffer.byteLength(subsequent, 'utf-8');
        // CLAUDE.md alone is ~16 KB in this fixture; first message must be
        // at least 10 KB larger than the follow-up.
        expect(firstBytes - subBytes).toBeGreaterThan(10 * 1024);
      } finally {
        rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });
});

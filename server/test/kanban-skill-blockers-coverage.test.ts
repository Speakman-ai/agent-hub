import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The legacy standalone `kanban` skill was retired in favor of the canonical
// `agent-hub-kanban` sub-skill; its detailed blocker documentation was folded
// into that skill's reference. The coverage guard follows the docs.
const DEFAULT_SKILL = path.join(
  __dirname,
  '..',
  'default-skills',
  'agent-hub-kanban',
  'references',
  'kanban.md',
);

/**
 * Coverage guard for the `agent-hub-kanban` skill.
 *
 * Blockers are a first-class concept on the board (cycle-checked edges,
 * autonomous-dispatcher skip semantics, UI confirm gating) but the skill
 * doc has historically described only the column CRUD. Agents that pick
 * up cards without knowing about blockers will step on dependencies.
 *
 * This test pins the surfaces that MUST stay in the shipped skill so a
 * future refactor can't accidentally strip the blocker documentation.
 * Each marker is specific enough that it can't be satisfied by the old
 * "List / Create / Move / Update" body alone.
 */
const REQUIRED_MARKERS: Array<{ surface: string; patterns: RegExp[] }> = [
  {
    surface: 'Blocker endpoint surface',
    patterns: [
      /\/board\/cards\/\$CARD_ID\/blockers/,
      /blockedByCardId/,
      /DELETE .*\/blockers\/\$BLOCKED_BY_CARD_ID/i,
    ],
  },
  {
    surface: 'Blocker response shape on GET /board',
    patterns: [/"blockers":/, /"blocks":/, /"done":/],
  },
  {
    surface: '409 error paths (duplicate + cycle)',
    patterns: [/duplicate/i, /cycle/i, /"path"/],
  },
  {
    surface: 'Soft-enforcement semantics',
    patterns: [
      /move endpoint.*(does not|not).*gate|soft/i,
      /autonomous.*(skip|dispatcher)/i,
      /backlog.*done.*(insensitive|never)|blocker-insensitive/i,
    ],
  },
  {
    surface: 'Workflow guidance for blockers',
    patterns: [
      /blockers\.every.*done/,
      /blocks.*(array|downstream)/i,
      /unresolved blocker|blocker.*not.*done/i,
    ],
  },
];

function assertAllMarkersPresent(file: string, label: string): void {
  const corpus = readFileSync(file, 'utf8');
  const missing: Array<{ surface: string; unmatched: string[] }> = [];
  for (const { surface, patterns } of REQUIRED_MARKERS) {
    const unmatched = patterns.filter((rx) => !rx.test(corpus)).map((rx) => rx.toString());
    if (unmatched.length > 0) missing.push({ surface, unmatched });
  }
  if (missing.length > 0) {
    throw new Error(`Missing blocker coverage in ${label}:\n${JSON.stringify(missing, null, 2)}`);
  }
}

describe('agent-hub-kanban skill documents card blockers', () => {
  it('default-skills/agent-hub-kanban/references/kanban.md covers every blocker surface', () => {
    expect(existsSync(DEFAULT_SKILL)).toBe(true);
    assertAllMarkersPresent(DEFAULT_SKILL, 'default-skills/agent-hub-kanban/references/kanban.md');
  });

  it('markers are specific enough to fail on accidental deletion', () => {
    // Sanity: the pre-blockers SKILL.md body (plain CRUD only) must fail.
    const preBlockersCorpus = [
      '---',
      'name: kanban',
      '---',
      '# Kanban Board Management',
      '## Available Actions',
      '### List cards',
      '### Create a card',
      '### Move a card',
      '### Update a card',
      '## Workflow',
      '1. Check the board for "To Do" cards',
    ].join('\n');
    const missing = REQUIRED_MARKERS.filter(({ patterns }) =>
      patterns.some((rx) => !rx.test(preBlockersCorpus)),
    );
    expect(missing.length).toBe(REQUIRED_MARKERS.length);
  });
});

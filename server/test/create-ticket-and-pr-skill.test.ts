import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { SHIP_SKILL_ID } from '../session-ship.js';

const DEFAULT_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../default-skills',
);
const SKILL_MD = path.join(DEFAULT_SKILLS_DIR, 'create-ticket-and-pr/SKILL.md');

describe('create-ticket-and-pr skill', () => {
  it('ships bundled SKILL.md with the expected skill id', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toContain('name: create-ticket-and-pr');
    expect(body).toContain('gh pr create');
    expect(body).toContain('kanban');
  });

  it('is the canonical bundled ship skill wired to SHIP_SKILL_ID', () => {
    // The retired `ship-pr` skill was the legacy twin of this one. This skill
    // must remain the single bundled ship recipe the server injects on manual
    // "Create ticket & PR" and autonomous/card-session auto-ship.
    expect(SHIP_SKILL_ID).toBe('create-ticket-and-pr');
    expect(existsSync(path.join(DEFAULT_SKILLS_DIR, SHIP_SKILL_ID, 'SKILL.md'))).toBe(true);
  });

  it('carries the Finalize-first shipping contract (coverage guard for retired ship-pr)', () => {
    // ship-pr was deleted in the default-skills audit; its Finalize-first
    // guidance lives here. Pin the load-bearing surfaces so a future refactor
    // cannot silently strip the shipping contract from the bundled skill set.
    const body = readFileSync(SKILL_MD, 'utf8');
    // Finalize-first section: card-linked + .agent-hub/ci.yaml must NOT gh pr create.
    expect(body).toMatch(/Finalize-first/i);
    expect(body).toContain('.agent-hub/ci.yaml');
    expect(body).toMatch(/do \*\*not\*\* (run|use) `?gh pr create/i);
    expect(body).toMatch(/Finalize Code Changes/);
    // Guardrails that protect main and the reviewer-owned merge.
    expect(body).toMatch(/[Nn]ever merge your own PR/);
    expect(body).toMatch(/auto-merge/i);
  });

  it('no retired ship skills remain in the bundled default-skills set', () => {
    for (const retired of ['ship-pr', 'kanban', 'wiki-search']) {
      expect(
        existsSync(path.join(DEFAULT_SKILLS_DIR, retired)),
        `default-skills/${retired} should have been removed in the skills audit`,
      ).toBe(false);
    }
  });
});

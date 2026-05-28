import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const SKILL_MD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../default-skills/create-ticket-and-pr/SKILL.md',
);

describe('create-ticket-and-pr skill', () => {
  it('ships bundled SKILL.md with the expected skill id', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toContain('name: create-ticket-and-pr');
    expect(body).toContain('gh pr create');
    expect(body).toContain('kanban');
  });
});

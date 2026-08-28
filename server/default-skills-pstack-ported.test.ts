/**
 * Integrity tests for the pstack-inspired bundled default skills.
 *
 * These four global (bundled-default) skills were ported from concepts in
 * Cursor's MIT-licensed `pstack` plugin and ship in `server/default-skills/`,
 * so every agent in every project loads them. A bundled default with invalid
 * frontmatter (bad slug, missing/oversized description, off-allowlist category)
 * would be silently unusable or would 409 against the write API's collision
 * guard. This suite runs each skill's raw SKILL.md through the SAME validator
 * the write API uses (`validateAndComposeSkill`) plus the discovery frontmatter
 * reader, so a malformed edit fails here instead of in production.
 *
 * Regression coverage for: shipping a default skill whose SKILL.md the loader
 * cannot accept, or whose slug does not match its directory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import {
  validateAndComposeSkill,
  ALLOWED_SKILL_CATEGORIES,
  SKILL_ID_RE,
  SKILL_ID_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_VERSION_MAX,
} from './skill-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.join(__dirname, 'default-skills');

/** The skills this PR added, by on-disk directory / expected slug. */
const PORTED_SKILLS = ['unslop', 'blast-radius', 'code-walkthrough', 'design-rationale'];

describe('pstack-ported bundled default skills', () => {
  it.each(PORTED_SKILLS)('%s ships a SKILL.md file', (slug) => {
    const file = path.join(DEFAULT_SKILLS_DIR, slug, 'SKILL.md');
    expect(existsSync(file), `${slug}/SKILL.md missing`).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
  });

  it.each(PORTED_SKILLS)('%s has frontmatter that passes the write-API validator', (slug) => {
    const raw = readFileSync(path.join(DEFAULT_SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    const result = validateAndComposeSkill({ content: raw });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (result.ok) {
      // The validator's derived slug must match the directory name, or the
      // loader would resolve the skill under a different id than it lives at.
      expect(result.slug).toBe(slug);
    }
  });

  it.each(PORTED_SKILLS)('%s frontmatter fields respect the schema bounds', (slug) => {
    const raw = readFileSync(path.join(DEFAULT_SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    const { data, content } = matter(raw);

    // name: slug-shaped, matches the directory, within length.
    expect(typeof data.name).toBe('string');
    expect(data.name).toBe(slug);
    expect(SKILL_ID_RE.test(data.name as string)).toBe(true);
    expect((data.name as string).length).toBeLessThanOrEqual(SKILL_ID_MAX);

    // description: present and within the published cap.
    expect(typeof data.description).toBe('string');
    const description = data.description as string;
    expect(description.trim().length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);

    // category: on the allowlist.
    expect(ALLOWED_SKILL_CATEGORIES).toContain(data.category);

    // version: present and within the cap.
    expect(typeof data.version).toBe('string');
    expect((data.version as string).length).toBeLessThanOrEqual(SKILL_VERSION_MAX);

    // Router convention: bundled skills carry explicit TRIGGER / DO NOT TRIGGER
    // guidance in the description so common English does not hijack routing.
    expect(description).toContain('TRIGGER');
    expect(description).toContain('DO NOT TRIGGER');

    // A real body ships (not just frontmatter).
    expect(content.trim().length).toBeGreaterThan(200);
  });
});

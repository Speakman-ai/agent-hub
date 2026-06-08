/**
 * Coverage guard for the compose-only `preview-setup` default skill.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, '..', 'default-skills', 'preview-setup');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

describe('preview-setup default skill — SKILL.md frontmatter', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('has a parseable YAML frontmatter with name/description/version', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    const match = body.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const fm = match![1];
    expect(fm).toMatch(/^name:\s*preview-setup\s*$/m);
    expect(fm).toMatch(/^description:/m);
    expect(fm).toMatch(/^version:\s*3\.0\.0\s*$/m);
  });

  it('frontmatter description mentions compose wizard and setup-wizard trigger', () => {
    const fm = readFileSync(SKILL_MD, 'utf8').match(/^---\n([\s\S]*?)\n---\n/)![1];
    expect(fm).toMatch(/Docker Compose/i);
    expect(fm).toMatch(/Triggered by/i);
    expect(fm).toMatch(/setup-wizard/);
  });

  it('body documents guided walkthrough surfaces', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toMatch(/isMonorepo/);
    expect(body).toMatch(/composeCandidates/);
    expect(body).toMatch(/README/);
    expect(body).toMatch(/setup-compose-bootstrap/);
    expect(body).toMatch(/setup-apply/);
    expect(body).toMatch(/preview\/build/);
    expect(body).toMatch(/agenthub:ask/);
    expect(body).toMatch(/preview\/wizard-complete/);
    expect(body).toMatch(/guided walkthrough/i);
  });

  it('sample wizard curls include the Hub API key header', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toMatch(/preview\/setup-apply[^\n]+X-API-Key: \$AGENT_HUB_API_KEY/);
    expect(body).toMatch(/preview\/build[^\n]+X-API-Key: \$AGENT_HUB_API_KEY/);
    expect(body).toMatch(/preview\/wizard-complete[^\n]+X-API-Key: \$AGENT_HUB_API_KEY/);
  });

  it('body uses PROJECT_ID placeholder (not undefined shell env vars)', () => {
    const body = readFileSync(SKILL_MD, 'utf8');
    expect(body).toMatch(/\*\*`PROJECT_ID`\*\*/);
    expect(body).toMatch(/\*\*`PROJECT_CWD`\*\*/);
    expect(body).not.toMatch(/\$PREVIEW_WIZARD_PROJECT_ID/);
    expect(body).not.toMatch(/\$AGENT_HUB_SKILL_DIR/);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { readCredentialsSchemaForSkill } from './skill-credentials-resolve.js';

describe('readCredentialsSchemaForSkill', () => {
  let ahw: string;
  beforeEach(() => {
    ahw = mkdtempSync(path.join(tmpdir(), 'skill-cred-schema-'));
  });

  it('prefers project workspace SKILL.md before bundled defaults', () => {
    const skillDir = path.join(ahw, 'skills', 'github');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: github
credentials:
  - name: CUSTOM_TOKEN
    label: Override
    required: false
    type: secret
---
`,
      'utf8',
    );
    const parsed = readCredentialsSchemaForSkill('github', { projectWorkspaces: [ahw] });
    expect(parsed.error).toBeNull();
    expect(parsed.credentials.map((c) => c.name)).toEqual(['CUSTOM_TOKEN']);
  });

  it('falls back to bundled default when workspace has no skill dir', () => {
    mkdirSync(ahw, { recursive: true });
    const parsed = readCredentialsSchemaForSkill('github', { projectWorkspaces: [ahw] });
    expect(parsed.error).toBeNull();
    expect(parsed.credentials.some((c) => c.name === 'GH_TOKEN')).toBe(true);
  });

  it('falls back to bundled default when workspace skill omits credentials block', () => {
    const skillDir = path.join(ahw, 'skills', 'github');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: github (stub)
---
# Stub
`,
      'utf8',
    );
    const parsed = readCredentialsSchemaForSkill('github', { projectWorkspaces: [ahw] });
    expect(parsed.error).toBeNull();
    expect(parsed.credentials.some((c) => c.name === 'GH_TOKEN')).toBe(true);
  });

  it('does not fall back when workspace skill has malformed credentials', () => {
    const skillDir = path.join(ahw, 'skills', 'github');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: github
credentials: not-an-array
---
`,
      'utf8',
    );
    const parsed = readCredentialsSchemaForSkill('github', { projectWorkspaces: [ahw] });
    expect(parsed.error).toContain('credentials must be an array');
  });
});

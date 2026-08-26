import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import {
  readOptionsSchemaForSkill,
  extractOptionsFromSkillContent,
} from './skill-options-resolve.js';

describe('extractOptionsFromSkillContent', () => {
  it('parses an options block from SKILL.md frontmatter', () => {
    const md = `---
name: survey-tracker
options:
  - name: SURVEY_TRACKER_ENV
    label: Environment
    choices:
      - value: dev
        label: Development
      - value: prod
        label: Production
    default: dev
---
Body.`;
    const parsed = extractOptionsFromSkillContent(md);
    expect(parsed.error).toBeNull();
    expect(parsed.options).toHaveLength(1);
    expect(parsed.options[0]!.name).toBe('SURVEY_TRACKER_ENV');
    expect(parsed.options[0]!.default).toBe('dev');
  });

  it('returns empty for a SKILL.md with no options', () => {
    expect(extractOptionsFromSkillContent('---\nname: x\n---\nbody').options).toEqual([]);
  });
});

describe('readOptionsSchemaForSkill', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'skill-opt-schema-'));
  });

  it('reads options from a project skill dir', () => {
    const skillDir = path.join(root, 'survey-tracker');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: survey-tracker
options:
  - name: SURVEY_TRACKER_ENV
    choices: [dev, prod]
    default: prod
---
`,
    );
    const parsed = readOptionsSchemaForSkill('survey-tracker', { projectSkillsDirs: [root] });
    expect(parsed.error).toBeNull();
    expect(parsed.options[0]!.default).toBe('prod');
  });

  it('returns empty (no error) for an unknown skill', () => {
    expect(readOptionsSchemaForSkill('nope', { projectSkillsDirs: [root] })).toEqual({
      options: [],
      error: null,
    });
  });
});

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent } from './helpers.js';
import type supertest from 'supertest';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('GET /api/agents/:agentId/skills/:skillId — credential schema', () => {
  it('returns 400 when SKILL.md credentials frontmatter is invalid', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const ahw = project.ahw as string;
    const skillDir = path.join(ahw, 'skills', 'bad-cred-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: bad-cred-skill
credentials: "nope"
---
`,
      'utf8',
    );

    const res = await request.get(`/api/agents/${agent.id}/skills/bad-cred-skill`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('invalid credentials in SKILL.md frontmatter');
  });
});

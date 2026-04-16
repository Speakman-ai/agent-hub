import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRequest, createProject, createAgent } from './helpers.js';
import type supertest from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = path.join(__dirname, '..', 'default-skills');
const PLUGIN_SKILLS_DIR = path.join(__dirname, '..', '..', 'plugin', 'skills');

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('babysit skill deprecation', () => {
  it('default-skills/ no longer ships a babysit directory', () => {
    expect(existsSync(path.join(DEFAULT_SKILLS_DIR, 'babysit'))).toBe(false);
  });

  it('plugin/skills/ no longer ships a babysit directory', () => {
    // plugin dir is optional, but if present it also must not contain babysit
    if (existsSync(PLUGIN_SKILLS_DIR)) {
      expect(existsSync(path.join(PLUGIN_SKILLS_DIR, 'babysit'))).toBe(false);
    }
  });

  it('GET /api/agents/:agentId/skills does not return babysit', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    const res = await request.get(`/api/agents/${agent.id}/skills`).expect(200);
    const skills = res.body as Array<{ id: string; name: string }>;

    expect(Array.isArray(skills)).toBe(true);
    for (const skill of skills) {
      expect(skill.id).not.toBe('babysit');
      expect(skill.name).not.toBe('babysit');
    }
  });

  it('GET /api/agents/:agentId/skills/babysit returns 404', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    await request.get(`/api/agents/${agent.id}/skills/babysit`).expect(404);
  });
});

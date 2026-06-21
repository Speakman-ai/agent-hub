import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface SkillResult {
  id: string;
  name: string;
  description: string;
  path: string;
}

describe('Project skills — write API (POST/PUT)', () => {
  const created: string[] = [];

  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  async function newProject(): Promise<{ id: string; ahw: string }> {
    const p = (await createProject()) as { id: string; ahw: string };
    expect(typeof p.ahw).toBe('string');
    return p;
  }

  it('POST creates a project skill and writes SKILL.md to disk', async () => {
    const proj = await newProject();
    const res = await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({
        name: 'my-skill',
        description: 'Do a thing. TRIGGER when the user wants the thing.',
        category: 'integration',
        version: '1.2.3',
        body: '# My Skill\n\nInstructions here.',
      })
      .expect(201);

    const body = res.body as SkillResult;
    expect(body.id).toBe('my-skill');
    expect(body.name).toBe('my-skill');

    const skillMd = path.join(proj.ahw, 'skills', 'my-skill', 'SKILL.md');
    created.push(path.join(proj.ahw, 'skills', 'my-skill'));
    expect(existsSync(skillMd)).toBe(true);

    const parsed = matter(readFileSync(skillMd, 'utf-8'));
    expect(parsed.data.name).toBe('my-skill');
    expect(parsed.data.description).toContain('TRIGGER');
    expect(parsed.data.category).toBe('integration');
    expect(parsed.data.version).toBe('1.2.3');
    expect(parsed.content).toContain('# My Skill');
  });

  it('the created skill is discoverable via the agent skills list', async () => {
    const proj = await newProject();
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'findable-skill', description: 'Find me.' })
      .expect(201);
    created.push(path.join(proj.ahw, 'skills', 'findable-skill'));

    // Read back through the same GET route the loader / Settings UI use.
    // (Read route is agent-scoped; create an agent under this project.)
    const agentRes = await request
      .post('/api/agents')
      .send({ id: `a-${proj.id}`, projectId: proj.id, name: 'A', engine: 'claude-code' })
      .expect(201);
    const agentId = (agentRes.body as { id: string }).id;

    const skill = await request.get(`/api/agents/${agentId}/skills/findable-skill`).expect(200);
    expect((skill.body as { content: string }).content).toContain('name: findable-skill');
  });

  it('POST accepts a raw `content`-only body (no structured fields)', async () => {
    const proj = await newProject();
    const res = await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({
        content:
          '---\nname: raw-only\ndescription: Authored from a single textarea.\ncategory: tooling\n---\n# Raw Only\n\nbody\n',
      })
      .expect(201);
    created.push(path.join(proj.ahw, 'skills', 'raw-only'));

    expect((res.body as SkillResult).id).toBe('raw-only');
    const parsed = matter(
      readFileSync(path.join(proj.ahw, 'skills', 'raw-only', 'SKILL.md'), 'utf-8'),
    );
    expect(parsed.data.name).toBe('raw-only');
    expect(parsed.data.description).toBe('Authored from a single textarea.');
    expect(parsed.data.category).toBe('tooling');
  });

  it('PUT accepts a raw `content`-only body', async () => {
    const proj = await newProject();
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'raw-edit', description: 'original' })
      .expect(201);
    const dir = path.join(proj.ahw, 'skills', 'raw-edit');
    created.push(dir);

    await request
      .put(`/api/projects/${proj.id}/skills/raw-edit`)
      .send({ content: '---\nname: raw-edit\ndescription: edited via content\n---\n# Edited\n' })
      .expect(200);

    const parsed = matter(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'));
    expect(parsed.data.description).toBe('edited via content');
    expect(parsed.content).toContain('# Edited');
  });

  it('round-trips unrecognized frontmatter keys through a raw `content` edit', async () => {
    const proj = await newProject();
    const raw =
      '---\nname: roundtrip\ndescription: keep my extras\ncategory: tooling\nallowed-tools:\n  - Bash\nlicense: MIT\n---\n# Roundtrip\n\nbody\n';
    await request.post(`/api/projects/${proj.id}/skills`).send({ content: raw }).expect(201);
    const dir = path.join(proj.ahw, 'skills', 'roundtrip');
    created.push(dir);

    // Simulate the editor: fetch the raw file and PUT it straight back unchanged.
    const onDisk = readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(matter(onDisk).data['allowed-tools']).toEqual(['Bash']);
    expect(matter(onDisk).data.license).toBe('MIT');

    await request
      .put(`/api/projects/${proj.id}/skills/roundtrip`)
      .send({ name: 'roundtrip', content: onDisk })
      .expect(200);

    const afterEdit = matter(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).data;
    // The unchanged save must NOT have dropped the unmanaged metadata.
    expect(afterEdit['allowed-tools']).toEqual(['Bash']);
    expect(afterEdit.license).toBe('MIT');
    expect(afterEdit.description).toBe('keep my extras');
  });

  it('POST rejects a raw `content` body whose frontmatter is invalid with 400', async () => {
    const proj = await newProject();
    // Frontmatter missing description.
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ content: '---\nname: no-desc\n---\nbody' })
      .expect(400);
  });

  it('POST rejects invalid frontmatter with 400', async () => {
    const proj = await newProject();
    // Missing description.
    await request.post(`/api/projects/${proj.id}/skills`).send({ name: 'bad-skill' }).expect(400);
    // Bad slug.
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'Bad Slug', description: 'x' })
      .expect(400);
    // Disallowed category.
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'cat-skill', description: 'x', category: 'nonsense' })
      .expect(400);
    // Malformed credentials.
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'cred-skill', description: 'x', credentials: [{ name: 'not valid' }] })
      .expect(400);
  });

  it('POST rejects overriding a bundled default skill with 409', async () => {
    const proj = await newProject();
    const res = await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'agent-hub-kanban', description: 'shadow attempt' })
      .expect(409);
    expect((res.body as { error: string }).error).toContain('bundled default');
    // Nothing should have been written.
    expect(existsSync(path.join(proj.ahw, 'skills', 'agent-hub-kanban'))).toBe(false);
  });

  it('POST rejects a duplicate project skill with 409 (use PUT)', async () => {
    const proj = await newProject();
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'dup-skill', description: 'first' })
      .expect(201);
    created.push(path.join(proj.ahw, 'skills', 'dup-skill'));
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'dup-skill', description: 'second' })
      .expect(409);
  });

  it('PUT updates an existing project skill', async () => {
    const proj = await newProject();
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'edit-me', description: 'original', body: 'v1' })
      .expect(201);
    const dir = path.join(proj.ahw, 'skills', 'edit-me');
    created.push(dir);

    await request
      .put(`/api/projects/${proj.id}/skills/edit-me`)
      .send({ name: 'edit-me', description: 'updated description', body: '# v2\n' })
      .expect(200);

    const parsed = matter(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'));
    expect(parsed.data.description).toBe('updated description');
    expect(parsed.content).toContain('# v2');
  });

  it('PUT rejects a rename (name must match the path id) with 400', async () => {
    const proj = await newProject();
    await request
      .post(`/api/projects/${proj.id}/skills`)
      .send({ name: 'fixed-id', description: 'x' })
      .expect(201);
    created.push(path.join(proj.ahw, 'skills', 'fixed-id'));

    await request
      .put(`/api/projects/${proj.id}/skills/fixed-id`)
      .send({ name: 'renamed', description: 'x' })
      .expect(400);
  });

  it('PUT returns 404 for an unknown project skill', async () => {
    const proj = await newProject();
    await request
      .put(`/api/projects/${proj.id}/skills/ghost`)
      .send({ name: 'ghost', description: 'x' })
      .expect(404);
  });

  it('POST/PUT return 404 for an unknown project', async () => {
    await request
      .post('/api/projects/does-not-exist-xyz/skills')
      .send({ name: 'x', description: 'y' })
      .expect(404);
  });
});

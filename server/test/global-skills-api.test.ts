import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type supertest from 'supertest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getRequest, createProject, createAgent } from './helpers.js';
import { resolveGlobalSkillsDir } from '../global-skills-dir.js';
import { resolveProjectSkillsDir } from '../project-model.js';

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

interface MergedSkill {
  id: string;
  source: 'project' | 'global' | 'default';
}

describe('Global (shared) skills — write/read API', () => {
  const globalDir = resolveGlobalSkillsDir();
  const created: string[] = [];

  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  it('POST creates a global skill and writes SKILL.md under <dataDir>/skills', async () => {
    const res = await request
      .post('/api/global-skills')
      .send({
        name: 'shared-thing',
        description: 'Do a shared thing. TRIGGER when any project needs the thing.',
        category: 'integration',
        body: '# Shared Thing\n\nInstructions.',
      })
      .expect(201);

    const body = res.body as SkillResult & { source?: string };
    expect(body.id).toBe('shared-thing');
    // The create response must carry source so the in-memory `saved` object
    // takes the global delete path / shared badge before any list reload.
    expect(body.source).toBe('global');

    const skillMd = path.join(globalDir, 'shared-thing', 'SKILL.md');
    created.push(path.join(globalDir, 'shared-thing'));
    expect(existsSync(skillMd)).toBe(true);
    const parsed = matter(readFileSync(skillMd, 'utf-8'));
    expect(parsed.data.name).toBe('shared-thing');
    expect(parsed.data.category).toBe('integration');
    expect(parsed.content).toContain('# Shared Thing');
  });

  it('GET /api/global-skills lists user global skills and bundled built-ins', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'listed-global', description: 'List me.' })
      .expect(201);
    created.push(path.join(globalDir, 'listed-global'));

    const res = await request.get('/api/global-skills').expect(200);
    const body = res.body as MergedSkill[];
    const found = body.find((s) => s.id === 'listed-global');
    expect(found).toBeTruthy();
    expect(found?.source).toBe('global');
    expect(body.some((s) => s.source === 'default')).toBe(true);
  });

  it('GET /api/global-skills/:id returns the raw SKILL.md content', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'readable-global', description: 'Read me.' })
      .expect(201);
    created.push(path.join(globalDir, 'readable-global'));

    const res = await request.get('/api/global-skills/readable-global').expect(200);
    const body = res.body as { content: string; source: string };
    expect(body.content).toContain('name: readable-global');
    expect(body.source).toBe('global');
  });

  it('a global skill is merged into every agent skill list, tagged source=global', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'global-everywhere', description: 'Available to all agents.' })
      .expect(201);
    created.push(path.join(globalDir, 'global-everywhere'));

    // A fresh agent in a brand-new project must still see the global skill.
    const agent = await createAgent();
    const res = await request.get(`/api/agents/${agent.id}/skills`).expect(200);
    const body = res.body as MergedSkill[];
    const found = body.find((s) => s.id === 'global-everywhere');
    expect(found).toBeTruthy();
    expect(found?.source).toBe('global');
  });

  it('precedence: a project skill shadows a same-id global skill (project > global)', async () => {
    // Global tier owns the id first…
    await request
      .post('/api/global-skills')
      .send({ name: 'precedence-skill', description: 'global version' })
      .expect(201);
    created.push(path.join(globalDir, 'precedence-skill'));

    // …then a project authors a same-id skill.
    const project = (await createProject()) as { id: string; ahw: string };
    await request
      .post(`/api/projects/${project.id}/skills`)
      .send({ name: 'precedence-skill', description: 'project version' })
      .expect(201);
    created.push(path.join(resolveProjectSkillsDir(project), 'precedence-skill'));

    const agent = await createAgent({ projectId: project.id });
    const res = await request.get(`/api/agents/${agent.id}/skills`).expect(200);
    const body = res.body as MergedSkill[];
    const matches = body.filter((s) => s.id === 'precedence-skill');
    // Exactly one entry, and the PROJECT tier wins.
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe('project');
  });

  it('POST rejects shadowing a bundled default skill with 409', async () => {
    const res = await request
      .post('/api/global-skills')
      .send({ name: 'agent-hub-kanban', description: 'shadow attempt' })
      .expect(409);
    expect((res.body as { error: string }).error).toContain('bundled default');
    expect(existsSync(path.join(globalDir, 'agent-hub-kanban'))).toBe(false);
  });

  // NOTE: the FLAT-default (`<slug>.md`) collision case is covered in isolation
  // by server/skill-default-collision.test.ts (unit test of `skillDirHasSkill`
  // against a temp dir) rather than mutating the real server/default-skills dir
  // here. The directory-form default collision is exercised above with `kanban`.

  it('POST rejects a duplicate global skill with 409 (use PUT)', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'dup-global', description: 'first' })
      .expect(201);
    created.push(path.join(globalDir, 'dup-global'));
    await request
      .post('/api/global-skills')
      .send({ name: 'dup-global', description: 'second' })
      .expect(409);
  });

  it('POST rejects a duplicate of a FLAT (<slug>.md) global skill with 409', async () => {
    // loadSkillBody resolves a flat <slug>.md global skill, so creating a
    // second directory-form skill of the same id must 409 — not silently shadow.
    const flatId = 'flat-dup-global';
    mkdirSync(globalDir, { recursive: true });
    const flatPath = path.join(globalDir, `${flatId}.md`);
    writeFileSync(flatPath, `---\nname: ${flatId}\ndescription: a flat global skill.\n---\nbody\n`);
    created.push(flatPath);

    const res = await request
      .post('/api/global-skills')
      .send({ name: flatId, description: 'dir-form shadow attempt' })
      .expect(409);
    expect((res.body as { error: string }).error).toMatch(/already exists/i);
    // The directory-form skill must NOT have been written.
    expect(existsSync(path.join(globalDir, flatId))).toBe(false);
  });

  // ── Flat-form global skills (<globalDir>/<slug>.md) must be fully editable ──
  // loadSkillBody / the duplicate guard treat a flat <slug>.md as a real global
  // skill, so GET/PUT/DELETE must handle it too (not just the directory form).

  function writeFlatGlobal(slug: string, description: string): string {
    mkdirSync(globalDir, { recursive: true });
    const flatPath = path.join(globalDir, `${slug}.md`);
    writeFileSync(flatPath, `---\nname: ${slug}\ndescription: ${description}\n---\n# ${slug}\n`);
    created.push(flatPath);
    return flatPath;
  }

  it('GET resolves a FLAT global skill (editable in the UI)', async () => {
    writeFlatGlobal('flat-readable', 'a flat global');
    const res = await request.get('/api/global-skills/flat-readable').expect(200);
    const body = res.body as { content: string; source: string };
    expect(body.content).toContain('name: flat-readable');
    expect(body.source).toBe('global');
  });

  it('PUT updates a FLAT global skill in place (stays flat, no dir created)', async () => {
    const flatPath = writeFlatGlobal('flat-editable', 'original');
    await request
      .put('/api/global-skills/flat-editable')
      .send({ name: 'flat-editable', description: 'updated via PUT', body: '# v2\n' })
      .expect(200);
    const parsed = matter(readFileSync(flatPath, 'utf-8'));
    expect(parsed.data.description).toBe('updated via PUT');
    expect(parsed.content).toContain('# v2');
    // Must not have created a competing directory-form skill.
    expect(existsSync(path.join(globalDir, 'flat-editable'))).toBe(false);
  });

  it('DELETE removes a FLAT global skill from disk', async () => {
    const flatPath = writeFlatGlobal('flat-deletable', 'goner');
    expect(existsSync(flatPath)).toBe(true);
    await request.delete('/api/global-skills/flat-deletable').expect(200);
    expect(existsSync(flatPath)).toBe(false);
    const list = await request.get('/api/global-skills').expect(200);
    expect((list.body as MergedSkill[]).some((s) => s.id === 'flat-deletable')).toBe(false);
  });

  it('a FLAT global skill is discoverable in the agent merge by its bare slug', async () => {
    writeFlatGlobal('flat-discoverable', 'shows up for every agent');
    const agent = await createAgent();
    const res = await request.get(`/api/agents/${agent.id}/skills`).expect(200);
    const body = res.body as Array<{
      id: string;
      name: string;
      description: string;
      source: string;
    }>;
    const found = body.find((s) => s.id === 'flat-discoverable');
    // id is the bare slug (no `.md`) so edit/delete/allowlist all line up.
    expect(found).toBeTruthy();
    expect(found?.source).toBe('global');
    expect(found?.name).toBe('flat-discoverable');
    expect(found?.description).toBe('shows up for every agent');
    // The `.md`-suffixed form must NOT leak into discovery.
    expect(body.some((s) => s.id === 'flat-discoverable.md')).toBe(false);
  });

  it('POST rejects invalid frontmatter with 400', async () => {
    await request.post('/api/global-skills').send({ name: 'no-desc' }).expect(400);
    await request
      .post('/api/global-skills')
      .send({ name: 'Bad Slug', description: 'x' })
      .expect(400);
  });

  it('PUT updates an existing global skill; rejects rename (400) and unknown (404)', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'edit-global', description: 'original', body: 'v1' })
      .expect(201);
    const dir = path.join(globalDir, 'edit-global');
    created.push(dir);

    const putRes = await request
      .put('/api/global-skills/edit-global')
      .send({ name: 'edit-global', description: 'updated', body: '# v2\n' })
      .expect(200);
    expect((putRes.body as { source?: string }).source).toBe('global');
    const parsed = matter(readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'));
    expect(parsed.data.description).toBe('updated');
    expect(parsed.content).toContain('# v2');

    // Rename via PUT is not supported.
    await request
      .put('/api/global-skills/edit-global')
      .send({ name: 'renamed', description: 'x' })
      .expect(400);

    // Unknown global skill.
    await request
      .put('/api/global-skills/ghost-global')
      .send({ name: 'ghost-global', description: 'x' })
      .expect(404);
  });

  it('DELETE recursively removes a global skill that has nested resources', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'nested-global', description: 'has a references dir' })
      .expect(201);
    const dir = path.join(globalDir, 'nested-global');
    // Simulate referenced resources beside SKILL.md (references/, scripts/).
    mkdirSync(path.join(dir, 'references'), { recursive: true });
    writeFileSync(path.join(dir, 'references', 'about.md'), '# ref');
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi');

    // A flat unlink+rmdir would 500 here; recursive removal must succeed.
    await request.delete('/api/global-skills/nested-global').expect(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('DELETE removes a global skill', async () => {
    await request
      .post('/api/global-skills')
      .send({ name: 'delete-global', description: 'goner' })
      .expect(201);
    expect(existsSync(path.join(globalDir, 'delete-global'))).toBe(true);

    await request.delete('/api/global-skills/delete-global').expect(200);
    expect(existsSync(path.join(globalDir, 'delete-global'))).toBe(false);

    const res = await request.get('/api/global-skills').expect(200);
    expect((res.body as MergedSkill[]).some((s) => s.id === 'delete-global')).toBe(false);
  });
});

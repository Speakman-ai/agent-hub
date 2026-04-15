/**
 * Note Processing API Tests
 *
 * Tests the notes → agent pipeline: processing daily notes through the docs
 * agent for incorporation into wiki, memory, or kanban plans.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { getRequest, createProject, createAgent } from './helpers.js';
import { buildNoteProcessingPrompt } from '../routes/memory.js';

let request;

beforeAll(async () => {
  request = await getRequest();
});

// ═══════════════════════════════════════════════════════════════════
// Unit Tests: buildNoteProcessingPrompt
// ═══════════════════════════════════════════════════════════════════

describe('buildNoteProcessingPrompt', () => {
  const noteContent = '## 14:30\nDecided to use PostgreSQL for the new service.';
  const noteDate = '2026-04-15';
  const projectName = 'Test Project';

  it('builds auto prompt with all target options', () => {
    const prompt = buildNoteProcessingPrompt(noteContent, noteDate, 'auto', projectName);
    expect(prompt).toContain('Test Project');
    expect(prompt).toContain('2026-04-15');
    expect(prompt).toContain(noteContent);
    expect(prompt).toContain('Wiki');
    expect(prompt).toContain('Memory');
    expect(prompt).toContain('NO_ACTION_NEEDED');
  });

  it('builds wiki-targeted prompt', () => {
    const prompt = buildNoteProcessingPrompt(noteContent, noteDate, 'wiki', projectName);
    expect(prompt).toContain('wiki pages');
    expect(prompt).toContain('POST /api/projects/{projectId}/wiki');
    expect(prompt).not.toContain('NO_ACTION_NEEDED');
  });

  it('builds memory-targeted prompt', () => {
    const prompt = buildNoteProcessingPrompt(noteContent, noteDate, 'memory', projectName);
    expect(prompt).toContain('MEMORY.md');
    expect(prompt).toContain('lasting value');
  });

  it('builds plan-targeted prompt', () => {
    const prompt = buildNoteProcessingPrompt(noteContent, noteDate, 'plan', projectName);
    expect(prompt).toContain('kanban');
    expect(prompt).toContain('Backlog');
    expect(prompt).toContain('cards');
  });

  it('falls back to auto for unknown target', () => {
    const prompt = buildNoteProcessingPrompt(noteContent, noteDate, 'unknown', projectName);
    expect(prompt).toContain('NO_ACTION_NEEDED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Integration Tests: Note Processing API
// ═══════════════════════════════════════════════════════════════════

describe('Note Processing API', () => {
  let project;
  let docsAgent;

  beforeAll(async () => {
    // Create a project with a docs agent
    project = await createProject({ id: 'note-test-proj', name: 'Note Test' });
    docsAgent = await createAgent({
      projectId: project.id,
      id: 'note-test-docs',
      name: 'Note Test Docs',
      role: 'docs',
    });

    // Create a test note file in the project's ahw workspace
    const memoryDir = path.join(project.ahw, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      path.join(memoryDir, '2026-04-15.md'),
      '## 14:30\nDecided to use PostgreSQL for the new service.\n\n## 15:00\nSet up CI pipeline with GitHub Actions.\n',
    );
    // Also create an empty note
    writeFileSync(path.join(memoryDir, '2026-04-14.md'), '   \n');
  });

  describe('POST /api/projects/:projectId/notes/:date/process', () => {
    it('rejects invalid target', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2026-04-15/process`)
        .send({ target: 'invalid' })
        .expect(400);

      expect(res.body.error).toContain('Invalid target');
    });

    it('rejects invalid date format', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/04-15-2026/process`)
        .send({ target: 'auto' })
        .expect(400);

      expect(res.body.error).toContain('Invalid date format');
    });

    it('returns 404 for unknown project', async () => {
      await request
        .post('/api/projects/nonexistent/notes/2026-04-15/process')
        .send({ target: 'auto' })
        .expect(404);
    });

    it('returns 404 for missing note', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2099-01-01/process`)
        .send({ target: 'auto' })
        .expect(404);

      expect(res.body.error).toContain('No note found');
    });

    it('rejects empty note', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2026-04-14/process`)
        .send({ target: 'auto' })
        .expect(400);

      expect(res.body.error).toContain('empty');
    });

    it('creates a processing record for valid request', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2026-04-15/process`)
        .send({ target: 'wiki' })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(res.body.project_id).toBe(project.id);
      expect(res.body.note_date).toBe('2026-04-15');
      expect(res.body.target).toBe('wiki');
      expect(res.body.status).toBe('pending');
      expect(res.body).toHaveProperty('session_id');
    });

    it('defaults target to auto', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2026-04-15/process`)
        .send({})
        .expect(201);

      expect(res.body.target).toBe('auto');
    });

    it('uses excerpt when provided', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes/2026-04-15/process`)
        .send({ target: 'memory', excerpt: 'Just the PostgreSQL decision.' })
        .expect(201);

      expect(res.body.note_excerpt).toContain('PostgreSQL');
    });
  });

  describe('GET /api/projects/:projectId/notes/processings', () => {
    it('returns processings for a project', async () => {
      const res = await request.get(`/api/projects/${project.id}/notes/processings`).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('project_id');
      expect(res.body[0]).toHaveProperty('status');
    });

    it('returns 404 for unknown project', async () => {
      await request.get('/api/projects/nonexistent/notes/processings').expect(404);
    });

    it('respects limit parameter', async () => {
      const res = await request
        .get(`/api/projects/${project.id}/notes/processings?limit=1`)
        .expect(200);

      expect(res.body.length).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /api/projects/:projectId/notes/:date/processings', () => {
    it('returns processings for a specific date', async () => {
      const res = await request
        .get(`/api/projects/${project.id}/notes/2026-04-15/processings`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.every((p) => p.note_date === '2026-04-15')).toBe(true);
    });

    it('returns empty array for date with no processings', async () => {
      const res = await request
        .get(`/api/projects/${project.id}/notes/2020-01-01/processings`)
        .expect(200);

      expect(res.body).toEqual([]);
    });

    it('rejects invalid date format', async () => {
      await request.get(`/api/projects/${project.id}/notes/bad-date/processings`).expect(400);
    });
  });

  describe('GET /api/projects/:projectId/notes/processings/:processingId', () => {
    it('returns a specific processing', async () => {
      // First create one
      const createRes = await request
        .post(`/api/projects/${project.id}/notes/2026-04-15/process`)
        .send({ target: 'plan' })
        .expect(201);

      const res = await request
        .get(`/api/projects/${project.id}/notes/processings/${createRes.body.id}`)
        .expect(200);

      expect(res.body.id).toBe(createRes.body.id);
      expect(res.body.target).toBe('plan');
    });

    it('returns 404 for unknown processing', async () => {
      await request.get(`/api/projects/${project.id}/notes/processings/nonexistent-id`).expect(404);
    });
  });

  describe('Project without docs agent', () => {
    it('returns 404 when no docs agent exists', async () => {
      const proj = await createProject({ id: 'no-docs-proj', name: 'No Docs' });

      // Create the note file
      const memoryDir = path.join(proj.ahw, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(path.join(memoryDir, '2026-04-15.md'), 'Some content');

      const res = await request
        .post(`/api/projects/${proj.id}/notes/2026-04-15/process`)
        .send({ target: 'auto' })
        .expect(404);

      expect(res.body.error).toContain('docs agent');
    });
  });
});

/**
 * Notes API Test Suite
 *
 * Integration tests for the Notes REST endpoints.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createNote } from './helpers.js';
import type supertest from 'supertest';

let request: supertest.Agent;
let project: Record<string, unknown>;

beforeAll(async () => {
  request = await getRequest();
  project = await createProject({ id: 'notes-test-proj' });
});

describe('Notes CRUD', () => {
  describe('POST /api/projects/:projectId/notes', () => {
    it('creates a note with title and content', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes`)
        .send({ title: 'My First Note', content: '# Hello\n\nWorld' })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('My First Note');
      expect(res.body.content).toBe('# Hello\n\nWorld');
      expect(res.body.project_id).toBe(project.id);
    });

    it('creates a note with title only', async () => {
      const res = await request
        .post(`/api/projects/${project.id}/notes`)
        .send({ title: 'Title Only Note' })
        .expect(201);

      expect(res.body.title).toBe('Title Only Note');
      expect(res.body.content).toBe('');
    });

    it('rejects note without title', async () => {
      await request
        .post(`/api/projects/${project.id}/notes`)
        .send({ content: 'No title' })
        .expect(400);
    });

    it('returns 404 for non-existent project', async () => {
      await request
        .post('/api/projects/nonexistent/notes')
        .send({ title: 'Ghost Note' })
        .expect(404);
    });
  });

  describe('GET /api/projects/:projectId/notes', () => {
    it('lists all notes for a project', async () => {
      const proj = await createProject();
      await createNote(proj.id as string, { title: 'Note A' });
      await createNote(proj.id as string, { title: 'Note B' });

      const res = await request.get(`/api/projects/${proj.id}/notes`).expect(200);

      expect(res.body.length).toBe(2);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('title');
      expect(res.body[0]).toHaveProperty('created_at');
      expect(res.body[0]).toHaveProperty('updated_at');
    });

    it('returns empty array for project with no notes', async () => {
      const proj = await createProject();
      const res = await request.get(`/api/projects/${proj.id}/notes`).expect(200);
      expect(res.body).toEqual([]);
    });

    it('searches notes by query', async () => {
      const proj = await createProject();
      await createNote(proj.id as string, {
        title: 'React Hooks Guide',
        content: 'useState useEffect',
      });
      await createNote(proj.id as string, { title: 'Python Setup', content: 'pip install' });

      const res = await request.get(`/api/projects/${proj.id}/notes?q=React`).expect(200);

      expect(res.body.length).toBeGreaterThanOrEqual(1);
      expect(
        res.body.some((n: Record<string, unknown>) => (n.title as string).includes('React')),
      ).toBe(true);
    });
  });

  describe('GET /api/projects/:projectId/notes/:noteId', () => {
    it('returns a single note with full content', async () => {
      const note = await createNote(project.id as string, {
        title: 'Detail Note',
        content: '# Detailed\n\nFull content here.',
      });

      const res = await request.get(`/api/projects/${project.id}/notes/${note.id}`).expect(200);

      expect(res.body.id).toBe(note.id);
      expect(res.body.title).toBe('Detail Note');
      expect(res.body.content).toBe('# Detailed\n\nFull content here.');
    });

    it('returns 404 for non-existent note', async () => {
      await request.get(`/api/projects/${project.id}/notes/nonexistent`).expect(404);
    });
  });

  describe('PUT /api/projects/:projectId/notes/:noteId', () => {
    it('updates note title and content', async () => {
      const note = await createNote(project.id as string, {
        title: 'Original',
        content: 'Original content',
      });

      const res = await request
        .put(`/api/projects/${project.id}/notes/${note.id}`)
        .send({ title: 'Updated Title', content: 'Updated content' })
        .expect(200);

      expect(res.body.title).toBe('Updated Title');
      expect(res.body.content).toBe('Updated content');
    });

    it('updates only content when title is omitted', async () => {
      const note = await createNote(project.id as string, { title: 'Keep Title', content: 'Old' });

      const res = await request
        .put(`/api/projects/${project.id}/notes/${note.id}`)
        .send({ content: 'New content' })
        .expect(200);

      expect(res.body.title).toBe('Keep Title');
      expect(res.body.content).toBe('New content');
    });

    it('returns 404 for non-existent note', async () => {
      await request
        .put(`/api/projects/${project.id}/notes/nonexistent`)
        .send({ title: 'Ghost' })
        .expect(404);
    });

    it('returns 404 when noteId belongs to a different project', async () => {
      const otherProject = await createProject();
      const otherNote = await createNote(otherProject.id as string, {
        title: 'Other',
        content: 'Secret',
      });

      await request
        .put(`/api/projects/${project.id}/notes/${otherNote.id}`)
        .send({ title: 'Hijacked' })
        .expect(404);

      // Verify the note was NOT modified
      const res = await request
        .get(`/api/projects/${otherProject.id}/notes/${otherNote.id}`)
        .expect(200);
      expect(res.body.title).toBe('Other');
      expect(res.body.content).toBe('Secret');
    });
  });

  describe('DELETE /api/projects/:projectId/notes/:noteId', () => {
    it('deletes a note', async () => {
      const note = await createNote(project.id as string, { title: 'To Delete' });

      await request.delete(`/api/projects/${project.id}/notes/${note.id}`).expect(200);

      // Verify it's gone
      await request.get(`/api/projects/${project.id}/notes/${note.id}`).expect(404);
    });

    it('returns 404 for non-existent note', async () => {
      await request.delete(`/api/projects/${project.id}/notes/nonexistent`).expect(404);
    });

    it('returns 404 when noteId belongs to a different project', async () => {
      const otherProject = await createProject();
      const otherNote = await createNote(otherProject.id as string, {
        title: 'Protected',
        content: 'Safe',
      });

      await request.delete(`/api/projects/${project.id}/notes/${otherNote.id}`).expect(404);

      // Verify the note was NOT deleted
      const res = await request
        .get(`/api/projects/${otherProject.id}/notes/${otherNote.id}`)
        .expect(200);
      expect(res.body.title).toBe('Protected');
    });
  });
});

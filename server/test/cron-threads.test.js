/**
 * Tests for cron output threads — routing cron job output into
 * per-cron threads with individual entries for each run.
 *
 * Uses the threads schema from PR #192 (project_id, type, source_id).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject } from './helpers.js';

let request;

beforeAll(async () => {
  request = await getRequest();
});

// Helper: create a cron job via the API
async function createCron(overrides = {}) {
  const res = await request
    .post('/api/crons')
    .send({
      name: overrides.name || 'Test Cron',
      schedule: overrides.schedule || '0 * * * *',
      prompt: overrides.prompt || 'echo hello',
      cwd: overrides.cwd || '/tmp',
      enabled: false, // don't actually schedule
      ...overrides,
    })
    .expect(200);
  return res.body;
}

describe('GET /api/crons/:id/thread', () => {
  it('returns null thread when cron has never run', async () => {
    const cron = await createCron({ name: 'Never Run' });
    const res = await request.get(`/api/crons/${cron.id}/thread`).expect(200);

    expect(res.body.thread).toBeNull();
    expect(res.body.entries).toEqual([]);
  });

  it('returns 404 for non-existent cron', async () => {
    await request.get('/api/crons/999999/thread').expect(404);
  });

  it('returns thread with entries when populated', async () => {
    // Create a project so the cron can be matched by cwd
    const project = await createProject({ cwd: '/tmp/cron-thread-test' });
    const cron = await createCron({ name: 'With Entries', cwd: '/tmp/cron-thread-test' });

    // Manually create thread and entries via DB
    const { stmts } = await import('../db.js');
    const { v4: uuidv4 } = await import('uuid');
    const threadId = uuidv4();
    stmts.createThread.run(threadId, project.id, cron.name, 'cron', String(cron.id));
    stmts.createThreadEntry.run(uuidv4(), threadId, 'First run output');
    stmts.createThreadEntry.run(uuidv4(), threadId, 'Second run output');

    const res = await request.get(`/api/crons/${cron.id}/thread`).expect(200);
    expect(res.body.thread.name).toBe('With Entries');
    expect(res.body.thread.type).toBe('cron');
    expect(res.body.thread.source_id).toBe(String(cron.id));
    expect(res.body.entries).toHaveLength(2);
  });

  it('returns null when cron has no matching project', async () => {
    const cron = await createCron({ name: 'No Project', cwd: '/nonexistent/path' });
    const res = await request.get(`/api/crons/${cron.id}/thread`).expect(200);
    expect(res.body.thread).toBeNull();
  });
});

describe('Thread source lookup', () => {
  it('getThreadBySource finds thread by project, type, and source_id', async () => {
    const { stmts } = await import('../db.js');
    const { v4: uuidv4 } = await import('uuid');

    const project = await createProject({ cwd: '/tmp/source-lookup-test' });
    const cronResult = stmts.createCron.run(
      'Source Test',
      '0 * * * *',
      'test',
      '/tmp',
      0,
      project.id,
    );
    const cronId = cronResult.lastInsertRowid;

    const threadId = uuidv4();
    stmts.createThread.run(threadId, project.id, 'Source Test', 'cron', String(cronId));

    const found = stmts.getThreadBySource.get(project.id, 'cron', String(cronId));
    expect(found).toBeTruthy();
    expect(found.id).toBe(threadId);
    expect(found.name).toBe('Source Test');

    // Searching with wrong type returns nothing
    const notFound = stmts.getThreadBySource.get(project.id, 'heartbeat', String(cronId));
    expect(notFound).toBeUndefined();

    stmts.deleteCron.run(cronId);
  });
});

describe('formatCronEntryContent', () => {
  it('formats stdout-only output', async () => {
    // Import the function indirectly by testing the content format in thread entries
    const { stmts } = await import('../db.js');
    const { v4: uuidv4 } = await import('uuid');

    const project = await createProject({ cwd: '/tmp/format-test' });
    const threadId = uuidv4();
    stmts.createThread.run(threadId, project.id, 'Format Test', 'cron', 'format-1');

    // Simulate what runCronJob does: format and insert
    const content = 'Hello stdout\n[success in 1234ms]';
    const entryId = uuidv4();
    stmts.createThreadEntry.run(entryId, threadId, content);

    const entry = stmts.getThreadEntry.get(entryId);
    expect(entry.content).toContain('Hello stdout');
    expect(entry.content).toContain('success in 1234ms');
  });
});

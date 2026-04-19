/**
 * API integration tests for `GET /api/projects/:id/tool-errors`. Exercises the
 * happy path (single day), the `since` filter, and input validation.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getRequest, createProject } from './helpers.js';
import type supertest from 'supertest';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

function seedDailyNote(ahw: string, date: string, content: string): void {
  const memoryDir = path.join(ahw, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, `${date}.md`), content, 'utf-8');
}

describe('GET /api/projects/:projectId/tool-errors', () => {
  it('returns structured errors + counts when a daily note contains TOOL_ERROR lines', async () => {
    const project = await createProject();
    const ahw = (project.ahw as string) || '';
    expect(ahw).toBeTruthy();

    seedDailyNote(
      ahw,
      '2026-04-15',
      [
        '## 12:00',
        '```',
        'TOOL_ERROR | 2026-04-15T12:00:00Z | Bash | npm test | exit 1 | tsx missing',
        '```',
        '',
      ].join('\n'),
    );
    seedDailyNote(
      ahw,
      '2026-04-16',
      'TOOL_ERROR | 2026-04-16T03:00:00Z | Read | /tmp/foo | ENOENT | no such file\n',
    );

    const res = await request.get(`/api/projects/${project.id}/tool-errors`).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.returned).toBe(2);
    expect(res.body.truncated).toBe(false);
    expect(res.body.errors[0].timestamp).toBe('2026-04-16T03:00:00Z');
    expect(res.body.countsByTool).toEqual({ Bash: 1, Read: 1 });
    expect(res.body.countsByErrorType).toEqual({ 'exit 1': 1, ENOENT: 1 });
  });

  it('filters by since (inclusive)', async () => {
    const project = await createProject();
    const ahw = (project.ahw as string) || '';

    seedDailyNote(
      ahw,
      '2026-04-10',
      'TOOL_ERROR | 2026-04-10T12:00:00Z | Bash | old | exit 1 | old\n',
    );
    seedDailyNote(
      ahw,
      '2026-04-16',
      'TOOL_ERROR | 2026-04-16T02:00:00Z | Bash | new | exit 1 | new\n',
    );

    const res = await request
      .get(`/api/projects/${project.id}/tool-errors?since=2026-04-16`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.since).toBe('2026-04-16');
    expect(res.body.errors[0].summary).toBe('new');
  });

  it('rejects malformed since parameter', async () => {
    const project = await createProject();
    await request.get(`/api/projects/${project.id}/tool-errors?since=not-a-date`).expect(400);
  });

  it('returns 404 when project is missing', async () => {
    await request.get('/api/projects/no-such-project/tool-errors').expect(404);
  });

  it('returns empty aggregate when no daily notes exist', async () => {
    const project = await createProject();
    const res = await request.get(`/api/projects/${project.id}/tool-errors`).expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(res.body.countsByTool).toEqual({});
  });

  it('honours limit and flags truncated responses', async () => {
    const project = await createProject();
    const ahw = (project.ahw as string) || '';

    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`TOOL_ERROR | 2026-04-16T0${i}:00:00Z | Bash | cmd${i} | exit ${i} | err ${i}`);
    }
    seedDailyNote(ahw, '2026-04-16', lines.join('\n'));

    const res = await request.get(`/api/projects/${project.id}/tool-errors?limit=2`).expect(200);
    expect(res.body.total).toBe(5);
    expect(res.body.returned).toBe(2);
    expect(res.body.truncated).toBe(true);
  });
});

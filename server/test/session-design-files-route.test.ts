import './setup.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getRequest, createAgent, createSession } from './helpers.js';
import { routeDeps } from '../index.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;
const tempWorktrees: string[] = [];

/** Create a real temp worktree dir (with a design/ subdir) and bind it. */
function giveSessionRealWorktree(sessionId: string): string {
  const wt = mkdtempSync(path.join(tmpdir(), 'ah-design-route-'));
  tempWorktrees.push(wt);
  routeDeps.stmts.updateSessionWorktreePath.run(
    wt,
    `agent-hub/test/session-${sessionId.slice(0, 8)}`,
    sessionId,
  );
  return wt;
}

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'session-design-files-agent',
    name: 'Session Design Files Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

afterAll(() => {
  for (const wt of tempWorktrees) rmSync(wt, { recursive: true, force: true });
});

describe('GET /api/sessions/:sessionId/design-files', () => {
  it('returns 404 for an unknown session id', async () => {
    await request
      .get('/api/sessions/00000000-0000-4000-8000-0000000000aa/design-files')
      .expect(404);
  });

  it('returns an empty list for a session without a worktree', async () => {
    const session = await createSession({ agentId, name: 'design-files-no-worktree' });
    const res = await request.get(`/api/sessions/${session.id}/design-files`).expect(200);
    expect(res.body).toEqual({ files: [] });
  });

  it('returns an empty list when the worktree has no design artifacts yet', async () => {
    const session = await createSession({ agentId, name: 'design-files-empty' });
    giveSessionRealWorktree(session.id as string);
    const res = await request.get(`/api/sessions/${session.id}/design-files`).expect(200);
    expect(res.body.files).toEqual([]);
  });

  it('lists the design artifacts produced in the worktree', async () => {
    const session = await createSession({ agentId, name: 'design-files-listed' });
    const wt = giveSessionRealWorktree(session.id as string);
    const design = path.join(wt, 'design');
    mkdirSync(path.join(design, 'assets'), { recursive: true });
    writeFileSync(path.join(design, 'index.html'), '<h1>hello</h1>');
    writeFileSync(path.join(design, 'assets', 'app.js'), 'console.log(1)');

    const res = await request.get(`/api/sessions/${session.id}/design-files`).expect(200);
    const paths = res.body.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('assets/app.js');
  });
});

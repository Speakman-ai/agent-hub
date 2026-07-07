/**
 * Visibility guard for GET /api/sessions/cron (the scheduled-tasks sidebar).
 *
 * A shared cron (crons.shared = 1) is a project-wide scheduled task and must
 * appear in the sidebar for every org member, mirroring GET /api/crons. A
 * private cron stays visible only to its owner. The route reads `cron_shared`
 * off the `getAllCronSessions` join and OR's it with strict ownership.
 *
 * We mock `enrichSessionForClient` to an identity passthrough (so we don't
 * need the full stmts surface) and `userOwnsSession` to model "the caller
 * owns only their own private cron".
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps, SessionRow } from '../types.js';

vi.mock('../session-checkpoint-rewind.js', async () => {
  const actual = await vi.importActual<typeof import('../session-checkpoint-rewind.js')>(
    '../session-checkpoint-rewind.js',
  );
  return {
    ...actual,
    // Identity passthrough — the list route only cares about which rows
    // survive the filter, not the enriched wire shape.
    enrichSessionForClient: (row: SessionRow) => row,
  };
});

vi.mock('../session-ownership.js', async () => {
  const actual =
    await vi.importActual<typeof import('../session-ownership.js')>('../session-ownership.js');
  return {
    ...actual,
    // The caller owns only 'own-private'. Everything else they do not own.
    userOwnsSession: vi.fn((_req: unknown, id: string) => id === 'own-private'),
  };
});

const { default: createSessionRoutes } = await import('./sessions.js');

type CronRow = SessionRow & { cron_shared: number };

function cronRow(id: string, cron_shared: number): CronRow {
  return {
    id,
    agent_id: '_cron',
    name: `Cron ${id}`,
    engine: 'claude-code',
    model: 'claude-sonnet-4-6',
    use_worktree: 0,
    ask_mode: 0,
    cron_shared,
  } as CronRow;
}

function makeApp(rows: CronRow[]) {
  const stmts = {
    getAllCronSessions: { all: vi.fn(() => rows) },
  };
  const deps = {
    stmts,
    broadcast: vi.fn(),
    config: { publicUrl: null },
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createSessionRoutes(deps));
  return app;
}

describe('GET /api/sessions/cron — shared-cron sidebar visibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists shared crons plus the caller-owned private cron, hides others', async () => {
    const app = makeApp([
      cronRow('shared-a', 1), // shared → visible to everyone
      cronRow('own-private', 0), // private + owned → visible
      cronRow('other-private', 0), // private + not owned → hidden
      cronRow('shared-b', 1), // shared → visible to everyone
    ]);

    const res = await request(app).get('/api/sessions/cron').expect(200);
    const ids = (res.body as CronRow[]).map((s) => s.id).sort();
    expect(ids).toEqual(['own-private', 'shared-a', 'shared-b']);
  });

  it('shows a shared cron even when the caller owns nothing', async () => {
    const app = makeApp([cronRow('shared-only', 1), cronRow('someone-elses', 0)]);
    const res = await request(app).get('/api/sessions/cron').expect(200);
    expect((res.body as CronRow[]).map((s) => s.id)).toEqual(['shared-only']);
  });
});

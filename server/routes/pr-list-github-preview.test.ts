/**
 * GitHub PR detail carries `preview_available`, so the web and mobile PR
 * pages show the environment panel for GitHub-hosted projects too.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { RouteDeps } from '../types.js';

const fetched = vi.hoisted(() => ({
  pr: { number: 7, state: 'open', merged_at: null as string | null },
  headSha: 'a'.repeat(40) as string | null,
}));
vi.mock('../pr-detail-fetch.js', () => ({
  fetchPrDetail: vi.fn(async () => ({
    source: 'user-oauth',
    pr: fetched.pr,
    reviews: [],
    comments: [],
    checks: [],
    headSha: fetched.headSha,
  })),
}));
const probe = vi.hoisted(() => ({ present: true }));
vi.mock('../preview/pr-environment-config.js', () => ({
  hasPreviewConfigAtSha: vi.fn(async () => probe.present),
  probePreviewConfigAtSha: vi.fn(async () => (probe.present ? 'present' : 'absent')),
}));

import createPrListRoutes from './pr-list.js';

function app(env: { status: string; cleanupPending: boolean } | null, withEnvironments = true) {
  const deps = {
    findProject: (id: string) => (id === 'gh' ? { id: 'gh', githubRepo: 'acme/app' } : null),
    getProjects: () => [],
    prEnvironments: withEnvironments ? { get: vi.fn(() => env) } : undefined,
    config: {},
    stmts: {},
  } as unknown as RouteDeps;
  const a = express();
  a.use(createPrListRoutes(deps));
  return a;
}

describe('GitHub PR detail preview_available', () => {
  it('is true for an open PR whose head declares a preview', async () => {
    probe.present = true;
    fetched.pr.state = 'open';
    const res = await request(app(null)).get('/api/projects/gh/pulls/7');
    expect(res.status).toBe(200);
    expect(res.body.preview_available).toBe(true);
  });

  it('is false when the head has no preview block or environments are off', async () => {
    probe.present = false;
    expect((await request(app(null)).get('/api/projects/gh/pulls/7')).body.preview_available).toBe(
      false,
    );
    probe.present = true;
    expect(
      (await request(app(null, false)).get('/api/projects/gh/pulls/7')).body.preview_available,
    ).toBe(false);
  });

  it('stays true on a closed PR while its environment still runs', async () => {
    probe.present = false;
    fetched.pr.state = 'closed';
    const res = await request(app({ status: 'ready', cleanupPending: false })).get(
      '/api/projects/gh/pulls/7',
    );
    expect(res.body.preview_available).toBe(true);
    fetched.pr.state = 'open';
  });
});

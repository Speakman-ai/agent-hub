import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import createReleasesRoutes from './releases.js';

vi.mock('../github-releases.js', () => ({
  listUserFacingReleases: vi.fn(),
  findRelease: vi.fn((releases, v) =>
    releases.find((r: { version: string }) => r.version === v || r.version === v.replace(/^v/, '')),
  ),
}));

import { listUserFacingReleases } from '../github-releases.js';

const mockRelease = {
  version: '1.30.0',
  tag: 'v1.30.0',
  publishedAt: '2025-05-01T00:00:00Z',
  url: 'https://github.com/Speakman-ai/agent-hub/releases/tag/v1.30.0',
  summary: 'Added Release page.',
  sections: [{ title: "What's new", items: [{ text: 'Added Release page', hash: 'abc1234' }] }],
};

describe('GET /api/releases', () => {
  beforeEach(() => {
    vi.mocked(listUserFacingReleases).mockReset();
  });

  function buildApp() {
    const app = express();
    app.use(createReleasesRoutes());
    return app;
  }

  it('returns release list and selected version', async () => {
    vi.mocked(listUserFacingReleases).mockResolvedValue({
      repo: 'Speakman-ai/agent-hub',
      releases: [mockRelease],
      source: 'github',
    });
    const res = await supertest(buildApp()).get('/api/releases');
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe('Speakman-ai/agent-hub');
    expect(res.body.releases).toHaveLength(1);
    expect(res.body.selected.version).toBe('1.30.0');
    expect(res.body.selected.sections[0].title).toBe("What's new");
  });

  it('returns 500 when upstream fails', async () => {
    vi.mocked(listUserFacingReleases).mockRejectedValue(new Error('network'));
    const res = await supertest(buildApp()).get('/api/releases');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

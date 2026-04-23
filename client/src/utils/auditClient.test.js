import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchAuditReport,
  refreshAuditReport,
  fetchRosterSuggestions,
  saveRoster,
  fetchAgents,
} from './auditClient.js';

describe('auditClient', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockOk(body) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  function mockErr(status, bodyJson) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve(bodyJson ?? {}),
    });
  }

  describe('fetchAuditReport', () => {
    it('GETs /api/projects/:id/audit and returns parsed JSON', async () => {
      mockOk({ projectId: 'p1', score: 72 });
      const out = await fetchAuditReport('p1');
      expect(out).toEqual({ projectId: 'p1', score: 72 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/p1/audit');
    });

    it('URL-encodes the project id', async () => {
      mockOk({});
      await fetchAuditReport('project with spaces');
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/project%20with%20spaces/audit');
    });

    it('throws with server error detail on non-2xx', async () => {
      mockErr(500, { error: 'audit engine offline' });
      await expect(fetchAuditReport('p1')).rejects.toThrow(/500.*audit engine offline/);
    });

    it('throws a generic message when the error body is not JSON', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('not json')),
      });
      await expect(fetchAuditReport('p1')).rejects.toThrow(/Request failed: 502/);
    });

    it('requires a projectId', async () => {
      await expect(fetchAuditReport()).rejects.toThrow(/projectId/);
      await expect(fetchAuditReport('')).rejects.toThrow(/projectId/);
    });
  });

  describe('refreshAuditReport', () => {
    it('POSTs to /audit/refresh with the options body', async () => {
      mockOk({ jobId: 'j1' });
      await refreshAuditReport('p1', { categories: ['tests'] });
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/p1/audit/refresh');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ categories: ['tests'] });
    });

    it('defaults body to {} when no options passed', async () => {
      mockOk({});
      await refreshAuditReport('p1');
      const [, opts] = global.fetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({});
    });
  });

  describe('fetchRosterSuggestions', () => {
    it('GETs /api/projects/:id/roster/suggest', async () => {
      mockOk({ tracks: [{ id: 'architect' }] });
      const out = await fetchRosterSuggestions('p1');
      expect(out.tracks).toHaveLength(1);
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/p1/roster/suggest');
    });
  });

  describe('saveRoster', () => {
    it('POSTs /api/projects/:id/roster with payload', async () => {
      mockOk({ tracks: [], updatedAt: '2026-04-23T20:00:00Z' });
      const payload = { tracks: [{ id: 'architect', agentId: 'a', custom: false }] };
      await saveRoster('p1', payload);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/projects/p1/roster');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual(payload);
    });

    it('rejects without a payload', async () => {
      await expect(saveRoster('p1')).rejects.toThrow(/payload/);
      await expect(saveRoster('p1', null)).rejects.toThrow(/payload/);
      await expect(saveRoster('p1', 'nope')).rejects.toThrow(/payload/);
    });

    it('rejects without a projectId', async () => {
      await expect(saveRoster('', { tracks: [] })).rejects.toThrow(/projectId/);
    });
  });

  describe('fetchAgents', () => {
    it('GETs /api/agents', async () => {
      mockOk([{ id: 'a1', name: 'Agent One' }]);
      const agents = await fetchAgents();
      expect(agents).toHaveLength(1);
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/agents');
    });
  });

  describe('auth + content headers', () => {
    it('sends Content-Type and merges extras (from connection.js)', async () => {
      mockOk({});
      await fetchAuditReport('p1');
      const [, opts] = global.fetch.mock.calls[0];
      expect(opts.headers['Content-Type']).toBe('application/json');
    });
  });
});

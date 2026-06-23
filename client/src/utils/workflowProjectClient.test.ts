import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorkflowProject, slugifyProjectId } from './workflowProjectClient';

(vi as any).mock('./connection.js', () => ({
  getApiBase: () => 'http://localhost:3051/api',
  getAuthHeaders: () => ({ 'X-API-Key': 'k' }),
}));

describe('slugifyProjectId', () => {
  it('lowercases, trims, and replaces non-alnum runs with hyphens', () => {
    expect(slugifyProjectId('  My Research Project!! ')).toBe('my-research-project');
  });

  it('collapses repeated hyphens and strips leading/trailing ones', () => {
    expect(slugifyProjectId('---foo___bar---')).toBe('foo-bar');
  });

  it('caps the slug at 64 chars', () => {
    const long = 'a'.repeat(120);
    expect(slugifyProjectId(long).length).toBe(64);
  });

  it('returns an empty string for non-string / falsy input', () => {
    expect(slugifyProjectId(null)).toBe('');
    expect(slugifyProjectId(undefined)).toBe('');
    expect(slugifyProjectId('')).toBe('');
  });
});

describe('createWorkflowProject', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs /projects with mode:"workflow", a derived id, and default cwd', async () => {
    let captured: any;
    (globalThis as any).fetch = vi.fn(async (url: any, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({ id: 'my-research-project', mode: 'workflow' }),
      };
    });

    const proj = await createWorkflowProject({ name: 'My Research Project' });

    expect(captured.url).toBe('http://localhost:3051/api/projects');
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers['Content-Type']).toBe('application/json');
    expect(captured.init.headers['X-API-Key']).toBe('k');

    const body = JSON.parse(captured.init.body);
    expect(body!).toEqual({
      id: 'my-research-project',
      name: 'My Research Project',
      cwd: '/tmp',
      mode: 'workflow',
    });
    expect(proj!).toEqual({ id: 'my-research-project', mode: 'workflow' });
  });

  it('honors an explicit color and cwd when provided', async () => {
    (globalThis as any).fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.color).toBe('#3B82F6');
      expect(body.cwd).toBe('/var/data/wf');
      return { ok: true, json: async () => ({ id: body.id }) };
    });
    await createWorkflowProject({
      name: 'Ops Hub',
      color: '#3B82F6',
      cwd: '/var/data/wf',
    });
  });

  it('throws a 400 Error before fetching when name is empty', async () => {
    (globalThis as any).fetch = vi.fn();
    await expect(createWorkflowProject({ name: '   ' })).rejects.toMatchObject({
      message: 'name is required',
      status: 400,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws a 400 Error before fetching when the slug is invalid', async () => {
    (globalThis as any).fetch = vi.fn();
    await expect(createWorkflowProject({ name: '!!!' })).rejects.toMatchObject({
      status: 400,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('surfaces server 409 (duplicate id) with status preserved on the error', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Project id already exists' }),
    }));
    await expect(createWorkflowProject({ name: 'Dup' })).rejects.toMatchObject({
      status: 409,
      message: '409: Project id already exists',
    });
  });

  it('surfaces a generic failure when the server response is not JSON', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));
    await expect(createWorkflowProject({ name: 'Boom' })).rejects.toMatchObject({
      status: 500,
      message: 'Failed to create project (500)',
    });
  });
});

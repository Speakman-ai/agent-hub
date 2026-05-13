import { describe, it, expect } from 'vitest';
import { filterInternalOperations } from './openapi-filter.js';

describe('filterInternalOperations', () => {
  it('removes operations flagged x-internal: true and keeps public ones', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/public': {
          get: { summary: 'public', responses: { '200': { description: 'ok' } } },
        },
        '/mixed': {
          get: { summary: 'public', responses: { '200': { description: 'ok' } } },
          post: {
            'x-internal': true,
            summary: 'hidden',
            responses: { '200': { description: 'ok' } },
          },
        },
        '/internal-only': {
          get: {
            'x-internal': true,
            summary: 'hidden',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };

    const { spec: filtered, removedOperations, removedPaths } = filterInternalOperations(spec);
    const paths = filtered.paths as Record<string, Record<string, unknown>>;

    expect(paths['/public']).toBeDefined();
    expect(paths['/mixed']).toBeDefined();
    expect(paths['/mixed'].get).toBeDefined();
    expect(paths['/mixed'].post).toBeUndefined();
    expect(paths['/internal-only']).toBeUndefined();
    expect(removedOperations).toBe(2); // /mixed POST + /internal-only GET
    expect(removedPaths).toBe(1); // /internal-only fully dropped
  });

  it('drops an entire path when path-level x-internal: true is set', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/keep': { get: { responses: { '200': { description: 'ok' } } } },
        '/admin/internal': {
          'x-internal': true,
          get: { responses: { '200': { description: 'ok' } } },
          post: { responses: { '200': { description: 'ok' } } },
        },
      },
    };

    const { spec: filtered, removedOperations, removedPaths } = filterInternalOperations(spec);
    const paths = filtered.paths as Record<string, unknown>;

    expect(paths['/keep']).toBeDefined();
    expect(paths['/admin/internal']).toBeUndefined();
    expect(removedOperations).toBe(2);
    expect(removedPaths).toBe(1);
  });

  it('treats the "internal" tag the same as x-internal: true', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/tagged': {
          get: { tags: ['internal'], responses: { '200': { description: 'ok' } } },
          post: { tags: ['public'], responses: { '200': { description: 'ok' } } },
        },
      },
    };

    const { spec: filtered, removedOperations } = filterInternalOperations(spec);
    const ops = (filtered.paths as Record<string, Record<string, unknown>>)['/tagged'];

    expect(ops.get).toBeUndefined();
    expect(ops.post).toBeDefined();
    expect(removedOperations).toBe(1);
  });

  it('does not mutate the input spec (returns a deep clone)', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            'x-internal': true,
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(spec));

    filterInternalOperations(spec);

    expect(spec).toEqual(snapshot);
  });

  it('handles specs with no paths gracefully', () => {
    const spec = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' } };
    const { spec: filtered, removedOperations, removedPaths } = filterInternalOperations(spec);
    expect(filtered).toEqual(spec);
    expect(filtered).not.toBe(spec); // still a clone
    expect(removedOperations).toBe(0);
    expect(removedPaths).toBe(0);
  });

  it('throws TypeError when given a non-object spec', () => {
    expect(() => filterInternalOperations(null)).toThrow(TypeError);
    expect(() => filterInternalOperations('not-a-spec')).toThrow(TypeError);
    expect(() => filterInternalOperations([])).toThrow(TypeError);
  });

  it('keeps non-operation siblings (parameters/summary) when at least one op survives', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/with-params': {
          summary: 'Shared summary',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { responses: { '200': { description: 'ok' } } },
          delete: {
            'x-internal': true,
            responses: { '204': { description: 'no content' } },
          },
        },
      },
    };

    const { spec: filtered } = filterInternalOperations(spec);
    const path = (filtered.paths as Record<string, Record<string, unknown>>)['/with-params'];
    expect(path).toBeDefined();
    expect(path.summary).toBe('Shared summary');
    expect(path.parameters).toBeDefined();
    expect(path.get).toBeDefined();
    expect(path.delete).toBeUndefined();
  });

  it('honors a custom internalTags list', () => {
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/x': {
          get: { tags: ['admin-only'], responses: { '200': { description: 'ok' } } },
          post: { tags: ['public'], responses: { '200': { description: 'ok' } } },
        },
      },
    };

    const { spec: filtered, removedOperations } = filterInternalOperations(spec, {
      internalTags: ['admin-only'],
    });
    const ops = (filtered.paths as Record<string, Record<string, unknown>>)['/x'];
    expect(ops.get).toBeUndefined();
    expect(ops.post).toBeDefined();
    expect(removedOperations).toBe(1);
  });
});

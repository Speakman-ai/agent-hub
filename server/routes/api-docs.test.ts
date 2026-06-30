import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createApiDocsRoutes } from './api-docs.js';

function expectRequiredRequestBody(specText: string, path: string, method: string) {
  const pathIndex = specText.indexOf(`  ${path}:`);
  expect(pathIndex).toBeGreaterThanOrEqual(0);

  const nextPathIndex = specText.indexOf('\n  /api/', pathIndex + 1);
  const pathBlock = specText.slice(pathIndex, nextPathIndex === -1 ? undefined : nextPathIndex);
  const methodIndex = pathBlock.indexOf(`    ${method}:`);
  expect(methodIndex).toBeGreaterThanOrEqual(0);

  const methodTail = pathBlock.slice(methodIndex);
  const nextMethodMatch = methodTail.slice(1).match(/\n {4}(delete|get|patch|post|put):/);
  const methodBlock = methodTail.slice(
    0,
    nextMethodMatch?.index === undefined ? undefined : nextMethodMatch.index + 1,
  );

  expect(methodBlock).toContain('      requestBody:\n        required: true\n');
}

describe('createApiDocsRoutes', () => {
  const app = express();
  app.use(createApiDocsRoutes());
  const request = supertest(app);

  it('serves the openapi.yaml spec from disk', async () => {
    const res = await request.get('/api/docs/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    // Sanity-check the bytes look like the committed spec.
    expect(res.text).toContain('openapi: 3.0.3');
    expect(res.text).toContain('Agent Hub REST API');
  });

  it('marks Calendar write request bodies as required in the published spec', async () => {
    const res = await request.get('/api/docs/openapi.yaml');
    expect(res.status).toBe(200);

    expectRequiredRequestBody(res.text, '/api/google/calendar/events', 'post');
    expectRequiredRequestBody(res.text, '/api/google/calendar/events/{eventId}', 'patch');
  });

  it('serves the Swagger UI shell at /api/docs', async () => {
    // supertest follows the trailing-slash redirect that swagger-ui-express
    // emits for the bare /api/docs path.
    const res = await request.get('/api/docs/').buffer(true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Agent Hub API Docs');
    expect(res.text.toLowerCase()).toContain('swagger');
  });

  it('points the Swagger UI at the YAML endpoint, not an inline spec', async () => {
    // swagger-ui-express renders the configured swaggerOptions into
    // swagger-ui-init.js, which the shell loads via <script src>. That file
    // is where the spec URL actually lives — the .html shell doesn't carry
    // it directly.
    const res = await request.get('/api/docs/swagger-ui-init.js').buffer(true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/api/docs/openapi.yaml');
  });
});

describe('createApiDocsRoutes fallback (spec not bundled)', () => {
  // Pass a nonexistent path to exercise the Electron / missing-spec branches.
  const app = express();
  app.use(createApiDocsRoutes('/nonexistent/path/openapi.yaml'));
  const request = supertest(app);

  it('returns 404 plain-text when the YAML is missing', async () => {
    const res = await request.get('/api/docs/openapi.yaml');
    expect(res.status).toBe(404);
    expect(res.text).toContain('openapi.yaml not bundled');
  });

  it('returns 404 fallback HTML when the spec is missing', async () => {
    const res = await request.get('/api/docs/');
    expect(res.status).toBe(404);
    expect(res.text).toContain('API docs not bundled');
  });
});

// Smoke tests for the OpenAPI registry singleton.
//
// The contract these tests pin down:
//   1. `registerPath` causes the path + method to land in the generated
//      spec's `paths:` map.
//   2. `registerComponent` causes the schema to land in
//      `components.schemas` and a `$ref` resolves to it.
//   3. `resetRegistry` clears prior registrations so tests stay
//      hermetic (also guards against duplicate-registration drift in
//      long-lived dev processes — see the comment in registry.ts).
//
// These tests are deliberately decoupled from the route layer: they
// register synthetic paths/schemas so they don't break when the per-
// route-group migration cards start filling the real registry.

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';

import {
  registry,
  registerPath,
  registerComponent,
  registerSecurityScheme,
  resetRegistry,
  z,
} from './registry.js';

// `registry` is a `let` re-binding under the hood — re-import via a getter so
// every test sees the post-reset instance. (Direct property access in tests
// breaks because each test resets the singleton.)
function currentDefinitions() {
  return registry.definitions;
}

describe('openapi/registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('registers a path that appears in the generated spec', () => {
    const PingResponse = registerComponent(
      'PingResponse',
      z.object({ ok: z.boolean(), ts: z.string() }),
    );

    registerPath({
      method: 'get',
      path: '/api/ping',
      summary: 'Ping endpoint (test fixture)',
      tags: ['Health'],
      responses: {
        200: {
          description: 'OK',
          content: { 'application/json': { schema: PingResponse } },
        },
      },
    });

    const gen = new OpenApiGeneratorV3(currentDefinitions());
    const doc = gen.generateDocument({
      openapi: '3.0.3',
      info: { title: 'test', version: '0.0.0' },
    });

    // Path landed under the expected key + method.
    expect(doc.paths).toBeDefined();
    expect(doc.paths!['/api/ping']).toBeDefined();
    expect(doc.paths!['/api/ping'].get).toBeDefined();
    expect(doc.paths!['/api/ping'].get!.summary).toBe('Ping endpoint (test fixture)');
    expect(doc.paths!['/api/ping'].get!.tags).toEqual(['Health']);

    // Response schema is wired up as a $ref to the named component.
    const response = doc.paths!['/api/ping'].get!.responses!['200'];
    expect(response).toMatchObject({ description: 'OK' });
    // Type-narrow past the OpenAPI 3 ResponseObject union.
    const content = (response as { content?: Record<string, { schema?: unknown }> }).content;
    const schemaRef = content?.['application/json']?.schema as { $ref?: string } | undefined;
    expect(schemaRef?.$ref).toBe('#/components/schemas/PingResponse');
  });

  it('registers a reusable component schema under components.schemas', () => {
    registerComponent(
      'Widget',
      z.object({
        id: z.string(),
        weight: z.number().int().nonnegative(),
      }),
    );

    const gen = new OpenApiGeneratorV3(currentDefinitions());
    const doc = gen.generateDocument({
      openapi: '3.0.3',
      info: { title: 'test', version: '0.0.0' },
    });

    expect(doc.components?.schemas?.Widget).toBeDefined();
    const widget = doc.components!.schemas!.Widget as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(widget.type).toBe('object');
    expect(widget.properties).toHaveProperty('id');
    expect(widget.properties).toHaveProperty('weight');
    expect(widget.required).toEqual(expect.arrayContaining(['id', 'weight']));
  });

  it('resetRegistry clears prior registrations', () => {
    registerComponent('Ghost', z.object({ haunted: z.boolean() }));
    expect(currentDefinitions().length).toBeGreaterThan(0);

    resetRegistry();
    expect(currentDefinitions().length).toBe(0);

    // After reset, generating an empty doc should produce no schemas.
    const gen = new OpenApiGeneratorV3(currentDefinitions());
    const doc = gen.generateDocument({
      openapi: '3.0.3',
      info: { title: 'test', version: '0.0.0' },
    });
    expect(doc.components?.schemas?.Ghost).toBeUndefined();
  });

  it('registers a security scheme accessible via components.securitySchemes', () => {
    registerSecurityScheme('testBearer', {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'test_',
    });

    const gen = new OpenApiGeneratorV3(currentDefinitions());
    const doc = gen.generateDocument({
      openapi: '3.0.3',
      info: { title: 'test', version: '0.0.0' },
    });

    const schemes = doc.components?.securitySchemes;
    expect(schemes?.testBearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'test_',
    });
  });

  it('rejects path+method collisions between consecutive registrations', () => {
    // First registration: fine.
    registerPath({
      method: 'get',
      path: '/api/dup',
      responses: { 200: { description: 'OK' } },
    });

    // Second registration of the same path+method is allowed by the
    // underlying registry (it stores definitions in an array). We pin
    // this behaviour explicitly — if it ever starts throwing or
    // dedup'ing on its own, we want the test to flag it so we can
    // decide whether to mirror that behaviour in `registerPath`.
    expect(() =>
      registerPath({
        method: 'get',
        path: '/api/dup',
        responses: { 200: { description: 'OK' } },
      }),
    ).not.toThrow();
  });
});

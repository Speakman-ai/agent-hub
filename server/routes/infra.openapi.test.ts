/**
 * The published contract for the infra read routes matches what the handlers
 * actually enforce.
 *
 * This exists because of one specific trap. `z.coerce.*` has an *input* type of
 * `unknown`, and `unknown` admits `undefined`, so the generator infers "this
 * param is optional and nullable" regardless of what the runtime parser does
 * with a missing value. `from` and `to` shipped as `required: false` while the
 * route 400s without them — a generated client would have omitted both and
 * every request it produced would have failed.
 *
 * The document is generated from the registry rather than read off
 * `docs/api/openapi.yaml`, so this fails on the *schema* the moment it drifts.
 * The committed YAML is tied to the same schemas by the freshness gate
 * (`npm run check:openapi-freshness`), so the two together cover the artifact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from '../openapi/registry.js';
import './infra.openapi.js';

interface ParamObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string; nullable?: boolean };
}

let paths: Record<string, any>;

beforeAll(() => {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  paths = generator.generateDocument({
    openapi: '3.0.3',
    info: { title: 'test', version: '0.0.0' },
  }).paths as Record<string, any>;
});

function queryParams(path: string): ParamObject[] {
  const params = (paths[path]?.get?.parameters ?? []) as ParamObject[];
  return params.filter((p) => p.in === 'query');
}

function param(path: string, name: string): ParamObject {
  const found = queryParams(path).find((p) => p.name === name);
  if (!found) throw new Error(`no query param '${name}' documented on ${path}`);
  return found;
}

const METRICS = '/api/projects/{projectId}/infra/metrics';
const RESOURCES = '/api/projects/{projectId}/infra/resources';
const SERIES = '/api/projects/{projectId}/infra/metric-series';

describe('infra metric-range parameters', () => {
  it('publishes the window bounds as required', () => {
    // The route rejects a request missing either, so documenting them as
    // optional would make the spec describe a call that cannot succeed.
    expect(param(METRICS, 'from').required).toBe(true);
    expect(param(METRICS, 'to').required).toBe(true);
  });

  it('publishes the window bounds as plain integers', () => {
    // The same `unknown` input that made them optional also emitted a
    // spurious `nullable: true` — `?from=` is not a null epoch.
    for (const name of ['from', 'to']) {
      expect(param(METRICS, name).schema?.type).toBe('integer');
      expect(param(METRICS, name).schema?.nullable).toBeUndefined();
    }
  });

  it('publishes the series selector as required and its filters as optional', () => {
    expect(param(METRICS, 'resource').required).toBe(true);
    expect(param(METRICS, 'metric').required).toBe(true);
    // These narrow a series the server can otherwise pick from the catalog.
    for (const name of ['namespace', 'stat', 'dimensionsHash', 'period']) {
      expect(param(METRICS, name).required).toBe(false);
    }
  });

  it('publishes the catalog route’s resource key as required', () => {
    expect(param(SERIES, 'resource').required).toBe(true);
  });
});

describe('infra resource-list parameters', () => {
  it('publishes every filter as optional', () => {
    // An unfiltered list is the default view, so a client that omits all of
    // these is making a legitimate request.
    for (const p of queryParams(RESOURCES)) {
      expect(p.required).toBe(false);
    }
  });

  it('documents the filters the browser actually sends', () => {
    const names = queryParams(RESOURCES).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'service',
        'region',
        'accountId',
        'environment',
        'state',
        'search',
        'tagKey',
        'tagValue',
        'seenSince',
        'limit',
        'cursor',
      ]),
    );
  });
});

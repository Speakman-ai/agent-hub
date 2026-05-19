/**
 * Tests for the compose-file preview detector.
 *
 * These exercise the priority of compose filenames, the entry-service
 * heuristic (preferred names + fallback to first-in-declaration-order),
 * the container-side port extraction across compose's short and long
 * port-mapping shapes, and the env-file inference.
 *
 * Filesystem fixtures use a temp directory rather than mocking `fs` so
 * we exercise the real `yaml` parse + `existsSync` codepath.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { detectComposePreview, extractFirstContainerPort } from './detect-compose-preview.js';

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-hub-compose-detect-'));
}

describe('extractFirstContainerPort', () => {
  it('returns the container side of a short-form "host:container" mapping', () => {
    expect(extractFirstContainerPort(['3000:3000'])).toBe(3000);
    expect(extractFirstContainerPort(['8080:80'])).toBe(80);
  });

  it('handles IP-prefixed short-form mappings', () => {
    expect(extractFirstContainerPort(['127.0.0.1:8080:80'])).toBe(80);
  });

  it('strips trailing protocol suffixes', () => {
    expect(extractFirstContainerPort(['3000:3000/tcp'])).toBe(3000);
  });

  it('handles bare numeric strings', () => {
    expect(extractFirstContainerPort(['3000'])).toBe(3000);
  });

  it('handles long-form objects with `target`', () => {
    expect(extractFirstContainerPort([{ target: 8000, published: 8000, protocol: 'tcp' }])).toBe(
      8000,
    );
  });

  it('returns null when nothing parseable is present', () => {
    expect(extractFirstContainerPort([])).toBeNull();
    expect(extractFirstContainerPort(['not-a-port'])).toBeNull();
    expect(extractFirstContainerPort([{}])).toBeNull();
  });
});

describe('detectComposePreview', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore — temp cleanup is best-effort */
    }
  });

  it('returns null when no compose file exists', () => {
    expect(detectComposePreview(dir)).toBeNull();
  });

  it('returns null when workspaceDir does not exist', () => {
    expect(detectComposePreview(path.join(dir, 'no-such-subdir'))).toBeNull();
  });

  it('returns null when the YAML is malformed', () => {
    writeFileSync(path.join(dir, 'docker-compose.yml'), 'this: is: not: valid\n  - yaml');
    expect(detectComposePreview(dir)).toBeNull();
  });

  it('returns null when the compose file has no services key', () => {
    writeFileSync(path.join(dir, 'docker-compose.yml'), 'volumes:\n  data:\n');
    expect(detectComposePreview(dir)).toBeNull();
  });

  it('picks `frontend` as the entry service when present', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  backend:
    image: redis
  frontend:
    image: node
    ports:
      - "5173:5173"
`,
    );
    const got = detectComposePreview(dir);
    expect(got).not.toBeNull();
    expect(got?.stack).toBe('compose');
    expect(got?.compose.file).toBe('docker-compose.yml');
    expect(got?.compose.entryService).toBe('frontend');
    expect(got?.compose.entryPort).toBe(5173);
    expect(got?.compose.services).toEqual(['backend', 'frontend']);
  });

  it('prefers `web` when `frontend` is absent', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  api:
    image: node
  web:
    image: nginx
    ports:
      - "80:80"
`,
    );
    expect(detectComposePreview(dir)?.compose.entryService).toBe('web');
  });

  it('falls back to the first service when no preferred name matches', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  worker:
    image: redis
  api:
    image: node
`,
    );
    expect(detectComposePreview(dir)?.compose.entryService).toBe('worker');
  });

  it('falls back to default port 3000 when no ports mapping is present', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  frontend:
    image: node
`,
    );
    expect(detectComposePreview(dir)?.compose.entryPort).toBe(3000);
  });

  it('handles `compose.yml` as a valid filename', () => {
    writeFileSync(
      path.join(dir, 'compose.yml'),
      `services:
  app:
    image: node
    ports:
      - "8080:8080"
`,
    );
    const got = detectComposePreview(dir);
    expect(got?.compose.file).toBe('compose.yml');
    expect(got?.compose.entryService).toBe('app');
    expect(got?.compose.entryPort).toBe(8080);
  });

  it('suggests `.env.preview` as the env file when present', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  frontend:
    image: node
`,
    );
    writeFileSync(path.join(dir, '.env.preview'), 'FOO=bar\n');
    expect(detectComposePreview(dir)?.compose.envFile).toBe('.env.preview');
  });

  it('falls back to `.env` when `.env.preview` is absent', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  frontend:
    image: node
`,
    );
    writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
    expect(detectComposePreview(dir)?.compose.envFile).toBe('.env');
  });

  it('omits envFile when no .env* file sits next to the compose file', () => {
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  frontend:
    image: node
`,
    );
    expect(detectComposePreview(dir)?.compose.envFile).toBeUndefined();
  });

  it('preserves declaration order in the services list', () => {
    // YAML object preservation order is engine-dependent; the `yaml`
    // package preserves declaration order on parse, which is what we
    // rely on for the "first service" fallback. Pin it here so a
    // future dep bump that breaks the contract fails this test.
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:
  zeta:
    image: redis
  alpha:
    image: node
  middle:
    image: postgres
`,
    );
    expect(detectComposePreview(dir)?.compose.services).toEqual(['zeta', 'alpha', 'middle']);
  });
});

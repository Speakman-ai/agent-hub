import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  RUNNER_IMAGE_VERSIONS,
  MANIFEST_SNAPSHOT,
  runnerNodeMajor,
} from './runner-image-versions.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(here, 'runner', 'Dockerfile');

function readDockerfile(): string {
  return readFileSync(DOCKERFILE, 'utf8');
}

/** Extract an `ARG NAME=default` value from the Dockerfile. */
function argDefault(dockerfile: string, name: string): string | undefined {
  const m = new RegExp(`^ARG\\s+${name}=(\\S+)\\s*$`, 'm').exec(dockerfile);
  return m?.[1];
}

describe('runner image versions — recorded targets', () => {
  it('records the GitHub ubuntu-24.04 manifest snapshot the pins target', () => {
    // This test is the durable record of which versions the runner image aims to
    // match. If you bump the manifest, these expectations move with it.
    expect(RUNNER_IMAGE_VERSIONS).toEqual({
      node: '22.22.3',
      docker: '28.0.4',
      compose: '2.38.2',
      buildx: '0.34.1',
      githubCli: '2.95.0',
    });
    expect(MANIFEST_SNAPSHOT.image).toBe('ubuntu-24.04');
    expect(MANIFEST_SNAPSHOT.reconciledOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MANIFEST_SNAPSHOT.source).toContain('actions/runner-images');
  });

  it('uses well-formed version strings', () => {
    for (const [key, value] of Object.entries(RUNNER_IMAGE_VERSIONS)) {
      expect(value, key).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('derives the Node major line from the pinned patch version', () => {
    expect(runnerNodeMajor()).toBe('22');
    expect(runnerNodeMajor({ ...RUNNER_IMAGE_VERSIONS, node: '24.1.0' })).toBe('24');
  });
});

describe('runner image versions — Dockerfile drift guard', () => {
  // The Dockerfile ARG defaults are the actual soft pins applied at build time;
  // the TS constants are the source of truth other code / tests read. They MUST
  // stay in lockstep, or the recorded target lies about what the image ships.
  it('Dockerfile ARG defaults match the TS source of truth', () => {
    const df = readDockerfile();
    expect(argDefault(df, 'RUNNER_NODE_VERSION'), 'RUNNER_NODE_VERSION').toBe(
      RUNNER_IMAGE_VERSIONS.node,
    );
    expect(argDefault(df, 'RUNNER_DOCKER_VERSION'), 'RUNNER_DOCKER_VERSION').toBe(
      RUNNER_IMAGE_VERSIONS.docker,
    );
    expect(argDefault(df, 'RUNNER_COMPOSE_VERSION'), 'RUNNER_COMPOSE_VERSION').toBe(
      RUNNER_IMAGE_VERSIONS.compose,
    );
    expect(argDefault(df, 'RUNNER_BUILDX_VERSION'), 'RUNNER_BUILDX_VERSION').toBe(
      RUNNER_IMAGE_VERSIONS.buildx,
    );
    expect(argDefault(df, 'RUNNER_GH_VERSION'), 'RUNNER_GH_VERSION').toBe(
      RUNNER_IMAGE_VERSIONS.githubCli,
    );
  });

  it('NodeSource setup script selects the pinned Node major line', () => {
    const df = readDockerfile();
    // setup_${NODE_MAJOR}.x is derived from RUNNER_NODE_VERSION at build time.
    expect(df).toMatch(/NODE_MAJOR="\$\{RUNNER_NODE_VERSION%%\.\*\}"/);
    expect(df).toContain('setup_${NODE_MAJOR}.x');
  });

  it('keeps a build-time fallback so an aged-out pin does not break the build', () => {
    const df = readDockerfile();
    // Default (RUNNER_ENFORCE_VERSION_PINS=0) must degrade gracefully, not hard-fail.
    expect(df).toContain('RUNNER_ENFORCE_VERSION_PINS');
    expect(df).toMatch(/ARG RUNNER_ENFORCE_VERSION_PINS=0/);
  });

  it('constrains the Docker fallback to the recorded major line', () => {
    const df = readDockerfile();
    // The fallback must filter candidate versions to the SAME major as the
    // recorded RUNNER_*_VERSION — otherwise an aged-out 28.x pin could silently
    // install Docker 29 while the recorded target still says 28, defeating the
    // parity guard (reviewer note on the original soft-pin).
    expect(df).toContain('pick docker-ce "^5:${RUNNER_DOCKER_VERSION%%.*}');
    expect(df).toContain('pick docker-compose-plugin "^${RUNNER_COMPOSE_VERSION%%.*}');
    expect(df).toContain('pick docker-buildx-plugin "^${RUNNER_BUILDX_VERSION%%.*}');
  });

  it('installs GitHub CLI for deployment steps that dispatch workflows', () => {
    const df = readDockerfile();
    expect(df).toContain('https://cli.github.com/packages');
    expect(df).toContain('github-cli.list');
    expect(df).toContain('"gh=${RUNNER_GH_VERSION}"');
    expect(df).toContain('gh --version');
  });

  it('constrains the GitHub CLI fallback to the recorded major line', () => {
    const df = readDockerfile();
    expect(df).toContain('grep -E "^${RUNNER_GH_VERSION%%.*}');
    expect(df).toMatch(/no same-major fallback for gh[\s\S]*exit 1/);
  });

  it('refuses to cross majors silently when the recorded major aged out', () => {
    const df = readDockerfile();
    // If no same-major candidate exists, the build must fail (bump required)
    // rather than install a newer major behind the recorded target.
    expect(df).toMatch(/no same-major fallback[\s\S]*exit 1/);
  });
});

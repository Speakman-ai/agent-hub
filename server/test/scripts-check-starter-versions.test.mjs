import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  loadManifest,
  parseMajor,
  classifyBump,
  checkManifest,
  fetchLatestVersion,
  renderReport,
} from '../../scripts/lib/starter-versions-core.mjs';

import { main, parseArgs } from '../../scripts/check-starter-versions.mjs';

/**
 * Contract tests for the W3 base-image pipeline's starter-CLI version
 * bump detector. The detector is what gates the weekly `:latest` retag
 * on agent-hub's pr-env-base and scaffold-base images — it MUST:
 *
 *   - Refuse malformed manifests (the docker/scaffold-base Dockerfile
 *     reads the same version pins; drift = silent breakage).
 *   - Correctly classify no-change / minor-patch / major bumps.
 *   - Route `gh` through the GitHub Releases API, everything else
 *     through the npm registry.
 *   - Emit GitHub Actions step outputs in the canonical `key=value\n`
 *     format so the workflow can condition retags on `has_major_bump`.
 *   - Return exit code 0 on clean runs, 1 on major-bump detection, 2
 *     on bad invocation, 3 on transport failure.
 */

// ----------------- parseMajor ----------------------------------------------

describe('parseMajor', () => {
  it('extracts leading integer from plain semver', () => {
    expect(parseMajor('15.0.0')).toBe(15);
    expect(parseMajor('3.14.159')).toBe(3);
  });

  it('extracts leading integer from prerelease versions', () => {
    expect(parseMajor('15.0.0-canary.4')).toBe(15);
    expect(parseMajor('16.0.0-rc.1')).toBe(16);
  });

  it('throws on non-numeric input', () => {
    expect(() => parseMajor('latest')).toThrow(/cannot parse major/);
    expect(() => parseMajor('')).toThrow(/cannot parse major/);
  });
});

// ----------------- loadManifest --------------------------------------------

describe('loadManifest', () => {
  const good = {
    packages: {
      'create-next-app': {
        version: '15.0.0',
        major: 15,
        dockerArg: 'CREATE_NEXT_APP_VERSION',
      },
      gh: {
        version: '2.62.0',
        major: 2,
        dockerArg: 'GH_CLI_VERSION',
        source: 'github',
      },
    },
  };

  it('accepts a well-formed manifest', () => {
    const parsed = loadManifest(JSON.stringify(good));
    expect(parsed.packages['create-next-app'].major).toBe(15);
  });

  it('rejects non-JSON input', () => {
    expect(() => loadManifest('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a missing .packages field', () => {
    expect(() => loadManifest(JSON.stringify({ foo: 1 }))).toThrow(
      /manifest.packages must be an object/
    );
  });

  it('rejects version/major mismatch (the silent drift case)', () => {
    // Common footgun: bump `version` to 16.0.0 but forget to bump
    // `major` from 15. The Dockerfile ARG would read 16 but the
    // detector would still report "no bump" because pinnedMajor=15
    // equals the upstream major. We refuse to load in this case.
    const bad = JSON.parse(JSON.stringify(good));
    bad.packages['create-next-app'].version = '16.0.0';
    expect(() => loadManifest(JSON.stringify(bad))).toThrow(
      /parses to major 16, but manifest declares major 15/
    );
  });

  it('rejects an entry with non-string version', () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.packages['create-next-app'].version = 15;
    expect(() => loadManifest(JSON.stringify(bad))).toThrow(/\.version must be a string/);
  });

  it('rejects an entry with non-integer major', () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.packages.gh.major = 2.5;
    expect(() => loadManifest(JSON.stringify(bad))).toThrow(/\.major must be an integer/);
  });
});

// ----------------- classifyBump --------------------------------------------

describe('classifyBump', () => {
  const pinned = { version: '15.0.0', major: 15 };

  it('returns "none" when versions match', () => {
    expect(classifyBump(pinned, { latest: '15.0.0', major: 15 })).toBe('none');
  });

  it('returns "major" when upstream major is higher', () => {
    expect(classifyBump(pinned, { latest: '16.0.0', major: 16 })).toBe('major');
  });

  it('returns "minor-or-patch" when same major but different version', () => {
    expect(classifyBump(pinned, { latest: '15.2.1', major: 15 })).toBe(
      'minor-or-patch'
    );
  });

  it('returns "none" when upstream major rolled BACK (registry unpublish)', () => {
    // If the registry's `latest` dist-tag points at an older major
    // than our pin, we should NOT raise a major-bump alert — we pin
    // explicit versions; the rollback doesn't affect what ships.
    expect(classifyBump(pinned, { latest: '14.2.0', major: 14 })).toBe('none');
  });
});

// ----------------- fetchLatestVersion -------------------------------------

describe('fetchLatestVersion', () => {
  it('hits npm registry for npm-sourced packages', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ version: '15.4.2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await fetchLatestVersion('create-next-app', { fetchImpl });
    expect(result).toEqual({
      name: 'create-next-app',
      latest: '15.4.2',
      major: 15,
      source: 'npm',
    });
    expect(calls[0]).toContain('registry.npmjs.org/create-next-app/latest');
  });

  it('hits GitHub Releases API when source=github', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ tag_name: 'v2.65.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await fetchLatestVersion('gh', { fetchImpl, source: 'github' });
    expect(result.latest).toBe('2.65.0');
    expect(result.major).toBe(2);
    expect(result.source).toBe('github');
    expect(calls[0].url).toContain('api.github.com/repos/cli/cli/releases/latest');
    // Required by GitHub's API style guide (2022-11-28 versioning).
    expect(calls[0].init.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('rejects source=github for non-gh packages (hardcoded whitelist)', async () => {
    await expect(
      fetchLatestVersion('create-next-app', {
        fetchImpl: async () => new Response('{}', { status: 200 }),
        source: 'github',
      })
    ).rejects.toThrow(/source=github is only supported for "gh"/);
  });

  it('surfaces non-2xx registry responses as errors', async () => {
    const fetchImpl = async () =>
      new Response('<html>not found</html>', { status: 404 });
    await expect(
      fetchLatestVersion('create-next-app', { fetchImpl })
    ).rejects.toThrow(/npm registry returned 404/);
  });

  it('surfaces malformed npm responses as errors', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchLatestVersion('create-next-app', { fetchImpl })
    ).rejects.toThrow(/has no \.version/);
  });
});

// ----------------- checkManifest ------------------------------------------

describe('checkManifest', () => {
  function makeFetch(versionsByName) {
    return async (url) => {
      if (url.includes('api.github.com/repos/cli/cli/releases/latest')) {
        return new Response(
          JSON.stringify({ tag_name: `v${versionsByName.gh}` }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const m = /registry\.npmjs\.org\/([^/]+)\/latest/.exec(url);
      if (!m) throw new Error(`unexpected URL: ${url}`);
      const name = decodeURIComponent(m[1]);
      const v = versionsByName[name];
      if (v == null) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ version: v }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  const manifest = {
    packages: {
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'CREATE_NEXT_APP_VERSION' },
      'create-expo-app': { version: '3.0.0', major: 3, dockerArg: 'CREATE_EXPO_APP_VERSION' },
      gh: { version: '2.62.0', major: 2, dockerArg: 'GH_CLI_VERSION', source: 'github' },
    },
  };

  it('reports hasMajorBump=false when all entries match', async () => {
    const result = await checkManifest(manifest, {
      fetchImpl: makeFetch({
        'create-next-app': '15.0.0',
        'create-expo-app': '3.0.0',
        gh: '2.62.0',
      }),
    });
    expect(result.hasMajorBump).toBe(false);
    expect(result.bumps.every((b) => b.kind === 'none')).toBe(true);
  });

  it('reports hasMajorBump=true when ANY entry jumped major', async () => {
    const result = await checkManifest(manifest, {
      fetchImpl: makeFetch({
        'create-next-app': '16.0.0', // MAJOR bump
        'create-expo-app': '3.2.1', // minor
        gh: '2.62.0', // none
      }),
    });
    expect(result.hasMajorBump).toBe(true);
    const next = result.bumps.find((b) => b.name === 'create-next-app');
    expect(next.kind).toBe('major');
    expect(next.latestMajor).toBe(16);
    const expo = result.bumps.find((b) => b.name === 'create-expo-app');
    expect(expo.kind).toBe('minor-or-patch');
  });

  it('does not alert on minor or patch bumps alone', async () => {
    const result = await checkManifest(manifest, {
      fetchImpl: makeFetch({
        'create-next-app': '15.4.2',
        'create-expo-app': '3.1.0',
        gh: '2.65.0',
      }),
    });
    expect(result.hasMajorBump).toBe(false);
  });
});

// ----------------- renderReport -------------------------------------------

describe('renderReport', () => {
  it('calls out the major-bump case prominently', () => {
    const out = renderReport({
      bumps: [
        {
          name: 'create-next-app',
          pinned: '15.0.0',
          latest: '16.0.0',
          pinnedMajor: 15,
          latestMajor: 16,
          source: 'npm',
          kind: 'major',
        },
      ],
      hasMajorBump: true,
    });
    expect(out).toMatch(/MAJOR/);
    expect(out).toMatch(/:latest tag retag will be SKIPPED/);
  });

  it('says "safe" when no major bumps', () => {
    const out = renderReport({
      bumps: [
        {
          name: 'create-next-app',
          pinned: '15.0.0',
          latest: '15.0.0',
          pinnedMajor: 15,
          latestMajor: 15,
          source: 'npm',
          kind: 'none',
        },
      ],
      hasMajorBump: false,
    });
    expect(out).toMatch(/Safe to retag :latest/);
  });
});

// ----------------- CLI main() ---------------------------------------------

function makeManifestFile(packages) {
  const root = mkdtempSync(join(tmpdir(), 'starter-versions-'));
  const p = join(root, 'manifest.json');
  writeFileSync(p, JSON.stringify({ packages }));
  return {
    path: p,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function collect() {
  const stream = new PassThrough();
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
  });
  // PassThrough in flowing mode triggers 'data' events as we write,
  // but we need synchronous access in tests. Expose a `.read()` that
  // drains into buf first.
  return {
    stream,
    get text() {
      // Ensure any backlogged data is flushed synchronously.
      const pending = stream.read();
      if (pending) buf += pending.toString('utf8');
      return buf;
    },
  };
}

describe('parseArgs', () => {
  it('parses --manifest and --github-output and --json', () => {
    const out = parseArgs(['--manifest', '/a/b.json', '--github-output', '/tmp/x', '--json']);
    expect(out).toEqual({
      manifest: '/a/b.json',
      githubOutput: '/tmp/x',
      json: true,
    });
  });

  it('throws on unknown flags (exit code 2 territory)', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('main() CLI', () => {
  function fetchWithVersions(map) {
    return async (url) => {
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tag_name: `v${map.gh}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const m = /registry\.npmjs\.org\/([^/]+)\/latest/.exec(url);
      const name = decodeURIComponent(m[1]);
      return new Response(JSON.stringify({ version: map[name] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  it('returns exit code 0 when no major bumps', async () => {
    const file = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', file.path],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: fetchWithVersions({ 'create-next-app': '15.0.0' }),
        env: {},
      });
      expect(code).toBe(0);
      expect(out.text).toMatch(/Safe to retag :latest/);
    } finally {
      file.cleanup();
    }
  });

  it('returns exit code 1 when a major bump is detected', async () => {
    const file = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', file.path],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: fetchWithVersions({ 'create-next-app': '16.0.0' }),
        env: {},
      });
      expect(code).toBe(1);
      expect(out.text).toMatch(/MAJOR/);
    } finally {
      file.cleanup();
    }
  });

  it('returns exit code 2 on bad invocation (unknown flag)', async () => {
    const out = collect();
    const err = collect();
    const code = await main({
      argv: ['--nope'],
      stdout: out.stream,
      stderr: err.stream,
      fetchImpl: async () => new Response('{}', { status: 200 }),
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/unknown argument/);
  });

  it('returns exit code 2 when manifest file is missing', async () => {
    const out = collect();
    const err = collect();
    const code = await main({
      argv: ['--manifest', '/tmp/definitely-does-not-exist.json'],
      stdout: out.stream,
      stderr: err.stream,
      fetchImpl: async () => new Response('{}', { status: 200 }),
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text).toMatch(/cannot read/);
  });

  it('returns exit code 3 when the registry is unreachable', async () => {
    const file = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', file.path],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: async () => new Response('down', { status: 503 }),
        env: {},
      });
      expect(code).toBe(3);
      expect(err.text).toMatch(/503/);
    } finally {
      file.cleanup();
    }
  });

  it('writes GitHub Actions step outputs when --github-output is set', async () => {
    const manifestFile = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    const ghOutRoot = mkdtempSync(join(tmpdir(), 'gh-out-'));
    const ghOutPath = join(ghOutRoot, 'output');
    writeFileSync(ghOutPath, ''); // Actions always pre-creates the file
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', manifestFile.path, '--github-output', ghOutPath],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: fetchWithVersions({ 'create-next-app': '16.0.0' }),
        env: {},
      });
      expect(code).toBe(1);
      const written = readFileSync(ghOutPath, 'utf8');
      expect(written).toMatch(/has_major_bump=true/);
      expect(written).toMatch(/bumps_json=\[.*create-next-app.*\]/);
    } finally {
      manifestFile.cleanup();
      rmSync(ghOutRoot, { recursive: true, force: true });
    }
  });

  it('prefers $GITHUB_OUTPUT env var when --github-output is not provided', async () => {
    const manifestFile = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    const ghOutRoot = mkdtempSync(join(tmpdir(), 'gh-out-'));
    const ghOutPath = join(ghOutRoot, 'output');
    writeFileSync(ghOutPath, '');
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', manifestFile.path],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: fetchWithVersions({ 'create-next-app': '15.0.0' }),
        env: { GITHUB_OUTPUT: ghOutPath },
      });
      expect(code).toBe(0);
      const written = readFileSync(ghOutPath, 'utf8');
      expect(written).toMatch(/has_major_bump=false/);
    } finally {
      manifestFile.cleanup();
      rmSync(ghOutRoot, { recursive: true, force: true });
    }
  });

  it('emits --json machine-readable output when flag is set', async () => {
    const manifestFile = makeManifestFile({
      'create-next-app': { version: '15.0.0', major: 15, dockerArg: 'X' },
    });
    try {
      const out = collect();
      const err = collect();
      const code = await main({
        argv: ['--manifest', manifestFile.path, '--json'],
        stdout: out.stream,
        stderr: err.stream,
        fetchImpl: fetchWithVersions({ 'create-next-app': '15.1.0' }),
        env: {},
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text);
      expect(parsed.hasMajorBump).toBe(false);
      expect(parsed.bumps[0].kind).toBe('minor-or-patch');
    } finally {
      manifestFile.cleanup();
    }
  });
});

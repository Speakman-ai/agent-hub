import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dockerfilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Dockerfile');
const composePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docker-compose.yml',
);

const guestDockerfilePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'session-env',
  'firecracker',
  'build',
  'Dockerfile.guest',
);

// The exact claude-code CLI version both images must pin. Bump here (and in both
// Dockerfiles) together — the tests assert all three agree.
const EXPECTED_CLAUDE_CODE_PIN = '2.1.258';

// Every `@anthropic-ai/claude-code[@spec]` occurrence in a Dockerfile, returning
// the bare version each carries (`undefined` for an unpinned install).
function claudeCodePins(dockerfile: string): Array<string | undefined> {
  const specs = [...dockerfile.matchAll(/@anthropic-ai\/claude-code(?:@(\S+))?/g)];
  return specs.map(([, version]) => version);
}

describe('server/Dockerfile', () => {
  it('avoids recursive chown over full /app (Docker Desktop perf regression)', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const badRun = dockerfile.split('\n').some((line) => {
      const trimmed = line.trimStart();
      if (!/^RUN(\s+|$)/i.test(trimmed)) return false;
      if (!/chown\s+-R/i.test(trimmed)) return false;
      // Standalone image path /app (not a prefix like /app/uploads-only walks).
      return /(?:^|\s)\/app(?:\s|$)/.test(trimmed);
    });
    expect(badRun).toBe(false);
  });

  it('sets ownership at COPY time for runtime app tree', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const copyWithChown = [...dockerfile.matchAll(/^COPY --chown=node:node --from=/gm)].length;
    expect(copyWithChown).toBeGreaterThanOrEqual(5);
  });

  it('rebuilds every native addon in server/node_modules under --ignore-scripts', () => {
    // The build stage installs server deps with `npm ci --ignore-scripts`, which
    // skips each package's install/postinstall — the step that compiles native
    // addons. Any native module therefore MUST be listed in an explicit
    // `npm rebuild` or its binding is silently absent at runtime.
    //
    // Regression this guards: node-pty ships prebuilds for darwin/win32 ONLY, so
    // on the Linux runtime image its pty.node was never compiled and the Terminal
    // crashed with "Failed to load native module: pty.node". better-sqlite3 has
    // the same requirement (it was already rebuilt). If a new native dep is added
    // to server/package.json, add it to the rebuild list and to this test.
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const buildIdx = dockerfile.indexOf('FROM node:22-slim AS build');
    const clientIdx = dockerfile.indexOf('FROM node:22-slim AS client-build');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(clientIdx).toBeGreaterThan(buildIdx);
    const buildStage = dockerfile.slice(buildIdx, clientIdx);

    // Every server-side native module must appear in an `npm rebuild ...` line.
    const nativeServerModules = ['better-sqlite3', 'node-pty'];
    const rebuildLines = buildStage.split('\n').filter((line) => /npm rebuild/.test(line));
    expect(rebuildLines.length).toBeGreaterThan(0);
    for (const mod of nativeServerModules) {
      const rebuilt = rebuildLines.some((line) =>
        new RegExp(`npm rebuild\\b[^\\n]*\\b${mod.replace('.', '\\.')}\\b`).test(line),
      );
      expect(rebuilt, `expected build stage to \`npm rebuild ${mod}\``).toBe(true);
    }
  });

  it('installs python3 + venv + pip + packaging in the runtime stage', () => {
    // Agents shell out to python3 (e.g. data wrangling, ad-hoc scripts). The
    // build stage installs python only to compile better-sqlite3; that stage
    // is discarded. The runtime stage (FROM node:22-slim AS runtime) must
    // install python3 itself so `python3` is on PATH inside the container.
    // python3-packaging is required by node-gyp 10+ when sessions compile
    // native addons (node-pty).
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);
    for (const pkg of [
      'python3',
      'python3-venv',
      'python3-pip',
      'python3-packaging',
      'python3-setuptools',
    ]) {
      expect(runtimeStage, `expected runtime stage to install \`${pkg}\``).toMatch(
        new RegExp(`(^|\\s)${pkg}(\\s|$|\\\\)`, 'm'),
      );
    }
  });

  it('installs ripgrep in the runtime stage for agent searches', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);
    expect(runtimeStage, 'expected runtime stage to install `ripgrep`').toMatch(
      /(^|\s)ripgrep(\s|$|\\)/m,
    );
  });

  it('installs the AWS Session Manager plugin in the runtime stage', () => {
    // `aws ssm start-session` (SSM shells + port forwarding) shells out to the
    // session-manager-plugin binary; AWS CLI v2 alone is not enough. This guards
    // the regression where SSM sessions ENOENT out of the box.
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);
    // Fetches the official .deb and installs it.
    expect(runtimeStage, 'expected runtime stage to download the plugin .deb').toContain(
      'session-manager-downloads/plugin/latest/',
    );
    expect(runtimeStage, 'expected runtime stage to dpkg-install the plugin').toMatch(
      /dpkg -i\s+\S*session-manager-plugin\.deb/,
    );
    // Arch-aware: both amd64 and arm64 plugin builds are mapped.
    expect(runtimeStage).toContain('ubuntu_64bit');
    expect(runtimeStage).toContain('ubuntu_arm64');
  });

  it('bundles Playwright Chromium (browser + system deps) in the runtime stage', () => {
    // The preview `screenshot`/`navigate`/`click` ops and the `browser` tool drive
    // a Playwright-launched Chromium inside the container. If any of these steps is
    // dropped, the image ships without a working browser and every screenshot fails
    // with "MISSING ON DISK" (server/browser.ts) — the exact regression a stale/
    // hand-rolled image hits. Guard all three invariants:
    //   1. PLAYWRIGHT_BROWSERS_PATH pins the browser dir identically at build (root)
    //      and runtime (node); a mismatch makes chromium.executablePath() dangle.
    //   2. `playwright install-deps chromium` installs the system libs the pinned
    //      Chromium needs (a drifted lib set lets Chromium spawn then crash).
    //   3. `playwright install chromium` downloads the browser using the PINNED
    //      local playwright (bare `npx playwright`, never `npx --yes`, which would
    //      fetch a mismatched Chromium revision).
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);

    expect(runtimeStage, 'expected runtime stage to set PLAYWRIGHT_BROWSERS_PATH').toMatch(
      /ENV\s+PLAYWRIGHT_BROWSERS_PATH=\S+/,
    );
    expect(
      runtimeStage,
      'expected runtime stage to run `playwright install-deps chromium`',
    ).toMatch(/playwright\s+install-deps\s+chromium/);
    expect(runtimeStage, 'expected runtime stage to run `playwright install chromium`').toMatch(
      /playwright\s+install\s+chromium/,
    );
    // Must use the pinned local playwright, not `npx --yes` (mismatched revision).
    expect(
      runtimeStage,
      'expected `playwright install chromium` to NOT use `npx --yes`',
    ).not.toMatch(/npx\s+--yes\s+playwright\s+install\s+chromium/);
  });

  it('installs every supported agent-engine CLI in the runtime stage', () => {
    // Each engine in ALL_SUPPORTED_ENGINES needs its CLI baked into the image
    // so the engine works out of the box (config.ts points the *Bin paths at
    // these install locations). Adding an engine without its binary here is the
    // regression this guards: the engine is selectable but every spawn ENOENTs.
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);
    // engine id → a substring of the install command that fetches its binary.
    const engineInstallMarkers: Record<string, string> = {
      'claude-code': '@anthropic-ai/claude-code',
      'gemini-cli': '@google/gemini-cli',
      'codex-cli': '@openai/codex',
      'cursor-agent': 'cursor.com/install',
      'grok-cli': 'x.ai/cli/install.sh',
    };
    for (const [engine, marker] of Object.entries(engineInstallMarkers)) {
      expect(runtimeStage, `expected runtime stage to install the ${engine} CLI`).toContain(marker);
    }
  });

  it('pins the claude-code CLI to an exact version (not a bare/unpinned install)', () => {
    // Regression: an unpinned `npm install -g @anthropic-ai/claude-code` is
    // frozen by Docker layer caching at whatever was latest when the layer
    // first built, and never refreshes. Prod stranded on 2.1.243, which newer
    // models reject ("version 2.1.251 or newer is required"). The install MUST
    // pin an exact version so bumping the literal busts the cache and the floor
    // is auditable. Update this expectation when you bump the pin.
    const pins = claudeCodePins(readFileSync(dockerfilePath, 'utf8'));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin, 'claude-code install must pin an exact @x.y.z version').toBe(
        EXPECTED_CLAUDE_CODE_PIN,
      );
    }
  });
});

describe('firecracker guest Dockerfile', () => {
  it('pins claude-code to the exact same version as server/Dockerfile (lockstep)', () => {
    // The guest image mirrors the server runtime CLIs. It's not enough that the
    // guest merely pins *some* exact version — a drifted pin would give the two
    // images different CLIs. Assert both files agree, and that they agree on the
    // ticket's expected value, so a bump to only one file fails here.
    const serverPins = claudeCodePins(readFileSync(dockerfilePath, 'utf8'));
    const guestPins = claudeCodePins(readFileSync(guestDockerfilePath, 'utf8'));

    expect(serverPins.length).toBeGreaterThan(0);
    expect(guestPins.length).toBeGreaterThan(0);

    // Every pin across both files is the same exact version.
    const allPins = [...serverPins, ...guestPins];
    for (const pin of allPins) {
      expect(pin, 'claude-code install must pin an exact @x.y.z version').toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
    const unique = [...new Set(allPins)];
    expect(
      unique,
      'server and guest Dockerfiles must pin the identical claude-code version',
    ).toEqual([EXPECTED_CLAUDE_CODE_PIN]);
  });
});

describe('docker-compose.yml upload storage', () => {
  it('keeps fresh-host uploads under the existing writable data mount', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toContain('- AGENT_HUB_UPLOADS_DIR=/data/uploads');
    expect(compose).toContain('- AGENT_HUB_LEGACY_UPLOADS_DIR=/legacy-uploads');
    expect(compose).toContain('- server-uploads:/legacy-uploads:ro');
    expect(compose).toMatch(/\nvolumes:\n\s+server-uploads:\s*$/);
    expect(compose).not.toMatch(/^\s*-\s+.*\/uploads:\/app\/server\/uploads\s*$/m);
  });
});

describe('docker-compose.yml Finalize runner bootstrap', () => {
  it('builds the configured runner image before the server starts', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toMatch(
      /finalize-runner-image:\n\s+build:\n\s+context: \.\n\s+dockerfile: server\/finalize\/runner\/Dockerfile/,
    );
    expect(compose).toContain(
      'image: ${FINALIZE_RUNNER_IMAGE_UBUNTU_24_04:-agent-hub/finalize-runner:ubuntu-24.04}',
    );
    expect(compose).toMatch(
      /server:[\s\S]*?depends_on:\n\s+finalize-runner-image:\n\s+condition: service_completed_successfully/,
    );
  });

  it('uses a self-contained runner Dockerfile that bundles the fleet agent', () => {
    const runnerDockerfile = readFileSync(
      path.join(path.dirname(dockerfilePath), 'finalize', 'runner', 'Dockerfile'),
      'utf8',
    );

    expect(runnerDockerfile).toContain('FROM node:22-slim AS runner-agent-build');
    expect(runnerDockerfile).toContain('COPY server/package.json server/package-lock.json ./');
    expect(runnerDockerfile).toContain('--outfile=finalize/runner/runner-agent.mjs');
    expect(runnerDockerfile).toContain(
      'COPY --from=runner-agent-build /src/server/finalize/runner/runner-agent.mjs /usr/local/bin/runner-agent.mjs',
    );
    expect(runnerDockerfile).not.toMatch(/^COPY runner-agent\.mjs/m);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dockerfilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'Dockerfile');

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

  it('installs python3 + venv + pip in the runtime stage', () => {
    // Agents shell out to python3 (e.g. data wrangling, ad-hoc scripts). The
    // build stage installs python only to compile better-sqlite3; that stage
    // is discarded. The runtime stage (FROM node:22-slim AS runtime) must
    // install python3 itself so `python3` is on PATH inside the container.
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIdx);
    for (const pkg of ['python3', 'python3-venv', 'python3-pip']) {
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
});

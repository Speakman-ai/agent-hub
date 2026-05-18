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

  it('installs python3 + venv + pip in an apt-get install line of the runtime stage', () => {
    // Agents shell out to python3 (data wrangling, ad-hoc scripts, skill
    // helpers). The build stage installs python3 only to compile
    // better-sqlite3 and is discarded, so the runtime stage
    // (FROM node:22-slim AS runtime) needs its own copy.
    //
    // Two scoping safeguards to prevent a vacuous pass:
    //  - Slice the Dockerfile to the runtime stage only — the build stage
    //    already has `python3` on its own apt-get line, which would
    //    otherwise satisfy a naive grep even if the PR's additions were
    //    reverted.
    //  - Strip `#` comment lines — the rationale comment in this stage
    //    mentions `python3` in prose, and that must not be allowed to
    //    satisfy the assertion either.
    //  - Require each package to appear as a standalone token after an
    //    `apt-get install`, so e.g. `python3-venv` cannot stand in for a
    //    missing bare `python3`.
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const runtimeIdx = dockerfile.indexOf('FROM node:22-slim AS runtime');
    expect(runtimeIdx).toBeGreaterThan(-1);
    const runtimeCode = dockerfile
      .slice(runtimeIdx)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const pkg of ['python3', 'python3-venv', 'python3-pip']) {
      const re = new RegExp(`apt-get install[\\s\\S]*?(?<![\\w-])${pkg}(?![\\w-])`);
      expect(
        re.test(runtimeCode),
        `expected runtime stage apt-get install to include \`${pkg}\` as a standalone token`,
      ).toBe(true);
    }
  });
});

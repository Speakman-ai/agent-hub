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
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertClientTestDepsInstalled } from './assertClientTestDeps.js';

describe('assertClientTestDepsInstalled', () => {
  it('does not throw when devDependencies are installed', () => {
    expect(() => assertClientTestDepsInstalled()).not.toThrow();
  });

  it('throws with remediation when dev deps cannot be resolved (e.g. NODE_ENV=production install)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'client-test-deps-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'fake-client-stub', private: true }),
        'utf8',
      );
      expect(() => assertClientTestDepsInstalled(dir)).toThrow(Error);
      expect(() => assertClientTestDepsInstalled(dir)).toThrow(/npm ci --include=dev/);
      expect(() => assertClientTestDepsInstalled(dir)).toThrow(/@vitejs\/plugin-react/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

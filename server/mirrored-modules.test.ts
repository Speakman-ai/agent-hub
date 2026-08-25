import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareWithBaseline,
  fromBaselineShape,
  mirroredBasenames,
  sourceBasenames,
  toBaselineShape,
  type MirroredPair,
} from './mirrored-modules.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('sourceBasenames', () => {
  it('keeps .ts and .tsx sources and drops the extension', () => {
    expect(sourceBasenames(['api.ts', 'Chat.tsx', 'notes.md', 'style.css'])).toEqual([
      'Chat',
      'api',
    ]);
  });

  it('excludes tests and ambient declarations', () => {
    expect(sourceBasenames(['api.ts', 'api.test.ts', 'view.test.tsx', 'global.d.ts'])).toEqual([
      'api',
    ]);
  });

  it('collapses a .ts/.tsx pair of the same name to one basename', () => {
    expect(sourceBasenames(['view.ts', 'view.tsx'])).toEqual(['view']);
  });
});

describe('mirroredBasenames', () => {
  it('returns only basenames present on both sides', () => {
    expect(mirroredBasenames(['a.ts', 'b.ts', 'c.ts'], ['b.ts', 'c.tsx', 'd.ts'])).toEqual([
      'b',
      'c',
    ]);
  });

  it('is empty when a module lives on one side only (the migrated state)', () => {
    expect(mirroredBasenames(['webOnly.ts'], ['nativeOnly.ts'])).toEqual([]);
  });

  it('ignores a test file that happens to match a source basename', () => {
    expect(mirroredBasenames(['shared.ts'], ['shared.test.ts'])).toEqual([]);
  });
});

describe('compareWithBaseline', () => {
  const pair = (scope: string, basename: string): MirroredPair => ({ scope, basename });

  it('passes when disk and baseline agree', () => {
    const v = compareWithBaseline([pair('utils', 'api')], [pair('utils', 'api')]);
    expect(v.added).toEqual([]);
    expect(v.stale).toEqual([]);
  });

  it('flags a newly reintroduced pair', () => {
    const v = compareWithBaseline(
      [pair('utils', 'api'), pair('utils', 'coalesceInFlight')],
      [pair('utils', 'api')],
    );
    expect(v.added).toEqual([pair('utils', 'coalesceInFlight')]);
    expect(v.stale).toEqual([]);
  });

  it('flags a baseline entry whose pair migrated to shared/, forcing the ratchet down', () => {
    const v = compareWithBaseline([], [pair('hooks', 'useLogTail')]);
    expect(v.added).toEqual([]);
    expect(v.stale).toEqual([pair('hooks', 'useLogTail')]);
  });

  it('treats the same basename in different scopes as distinct pairs', () => {
    const v = compareWithBaseline([pair('hooks', 'time')], [pair('utils', 'time')]);
    expect(v.added).toEqual([pair('hooks', 'time')]);
    expect(v.stale).toEqual([pair('utils', 'time')]);
  });
});

describe('baseline serialization', () => {
  it('round-trips through the on-disk shape', () => {
    const pairs = [
      { scope: 'utils', basename: 'api' },
      { scope: 'hooks', basename: 'useWebSocket' },
      { scope: 'utils', basename: 'time' },
    ];
    expect(fromBaselineShape(toBaselineShape(pairs))).toEqual([
      { scope: 'hooks', basename: 'useWebSocket' },
      { scope: 'utils', basename: 'api' },
      { scope: 'utils', basename: 'time' },
    ]);
  });

  it('ignores underscore-prefixed doc keys', () => {
    expect(fromBaselineShape({ _comment: ['docs'], utils: ['api'] })).toEqual([
      { scope: 'utils', basename: 'api' },
    ]);
  });

  it('rejects a malformed entry loudly', () => {
    expect(() => fromBaselineShape({ utils: 'api' })).toThrow(/array of basenames/);
  });
});

describe('committed baseline', () => {
  const SCOPES = [
    { id: 'utils', clientDir: 'client/src/utils', mobileDir: 'mobile/src/utils' },
    { id: 'hooks', clientDir: 'client/src/hooks', mobileDir: 'mobile/src/hooks' },
  ];

  function scanRepo(): MirroredPair[] {
    const out: MirroredPair[] = [];
    for (const scope of SCOPES) {
      const client = readdirSync(join(repoRoot, scope.clientDir));
      const mobile = readdirSync(join(repoRoot, scope.mobileDir));
      for (const basename of mirroredBasenames(client, mobile)) {
        out.push({ scope: scope.id, basename });
      }
    }
    return out;
  }

  it('matches the repo exactly, so the check is green on main', () => {
    const path = join(repoRoot, 'scripts', 'mirrored-modules-baseline.json');
    expect(existsSync(path)).toBe(true);
    const baseline = fromBaselineShape(JSON.parse(readFileSync(path, 'utf8')));
    const verdict = compareWithBaseline(scanRepo(), baseline);
    expect(verdict.added).toEqual([]);
    expect(verdict.stale).toEqual([]);
  });

  it('no longer lists the modules this change moved into shared/', () => {
    const path = join(repoRoot, 'scripts', 'mirrored-modules-baseline.json');
    const listed = fromBaselineShape(JSON.parse(readFileSync(path, 'utf8'))).map(
      (p) => `${p.scope}/${p.basename}`,
    );
    expect(listed).not.toContain('utils/devServerConfig');
    expect(listed).not.toContain('utils/sessionMessagesResponse');
    expect(listed).not.toContain('utils/coalesceInFlight');
    expect(listed).not.toContain('hooks/useLogTail');
  });
});

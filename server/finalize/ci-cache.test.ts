import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildRestoreScript,
  buildSaveScript,
  cacheObjectPrefix,
  gitTreeHashFiles,
  globToRegExp,
  boundedCacheSetup,
  JobCacheSession,
  parseHashFilesArgs,
  resolveCacheKey,
  validateCachePath,
  validateKeyTemplate,
  type CacheStore,
  type CiCacheEntry,
} from './ci-cache.js';

const noHash = async () => {
  throw new Error('hashFiles should not be called');
};

describe('validateCachePath', () => {
  it('accepts relative paths and simple globs', () => {
    expect(validateCachePath('e2e-images')).toBeNull();
    expect(validateCachePath('backend-testdb-*.dump')).toBeNull();
    expect(validateCachePath('cypress/15.19.0')).toBeNull();
  });

  it('rejects absolute paths, traversal, option-like and shell-active paths', () => {
    expect(validateCachePath('/etc')).toMatch(/relative/);
    expect(validateCachePath('a/../b')).toMatch(/\.\./);
    expect(validateCachePath('-rf')).not.toBeNull();
    expect(validateCachePath('a b')).not.toBeNull();
    expect(validateCachePath('$(touch x)')).not.toBeNull();
    expect(validateCachePath('a;b')).not.toBeNull();
  });
});

describe('hashFiles parsing', () => {
  it('parses quoted glob lists', () => {
    expect(parseHashFilesArgs(`'a/**/*.py', "b.lock"`)).toEqual(['a/**/*.py', 'b.lock']);
    expect(parseHashFilesArgs(`'one'`)).toEqual(['one']);
  });

  it('rejects empty, unquoted, absolute and traversal globs', () => {
    expect(parseHashFilesArgs('')).toBeNull();
    expect(parseHashFilesArgs('a/*.py')).toBeNull();
    expect(parseHashFilesArgs(`'/etc/*'`)).toBeNull();
    expect(parseHashFilesArgs(`'../x'`)).toBeNull();
  });

  it('validateKeyTemplate flags malformed calls only', () => {
    expect(validateKeyTemplate(`db-\${{ hashFiles('m/*.py') }}`)).toBeNull();
    expect(validateKeyTemplate('plain-${FINALIZE_HEAD_SHA}')).toBeNull();
    expect(validateKeyTemplate(`db-\${{ hashFiles(m/*.py) }}`)).toMatch(/malformed/);
  });
});

describe('globToRegExp', () => {
  it('matches GHA-style globs', () => {
    const re = globToRegExp('backend/**/migrations/*.py');
    expect(re.test('backend/app/migrations/0001_init.py')).toBe(true);
    expect(re.test('backend/migrations/0001_init.py')).toBe(true);
    expect(re.test('backend/app/migrations/sub/0001.py')).toBe(false);
    expect(globToRegExp('**/package-lock.json').test('package-lock.json')).toBe(true);
    expect(globToRegExp('**/package-lock.json').test('a/b/package-lock.json')).toBe(true);
    expect(globToRegExp('*.txt').test('a/b.txt')).toBe(false);
    expect(globToRegExp('file.v?.txt').test('file.v1.txt')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('resolveCacheKey', () => {
  it('substitutes env vars and hashFiles digests', async () => {
    const hashFiles = vi.fn(async (globs: string[]) => `h${globs.length}`);
    const res = await resolveCacheKey(
      `db-\${{ hashFiles('a', 'b') }}-\${FINALIZE_HEAD_SHA}`,
      { FINALIZE_HEAD_SHA: 'abc' },
      hashFiles,
    );
    expect(res).toEqual({ ok: true, key: 'db-h2-abc' });
    expect(hashFiles).toHaveBeenCalledWith(['a', 'b'], undefined);
  });

  it('fails on an unset variable instead of caching under a literal placeholder', async () => {
    const res = await resolveCacheKey('img-${NOPE}', {}, noHash);
    expect(res.ok).toBe(false);
  });

  it('replaces characters outside the flat key charset', async () => {
    const res = await resolveCacheKey('feat/x y', {}, noHash);
    expect(res).toEqual({ ok: true, key: 'feat-x-y' });
  });
});

describe('gitTreeHashFiles', () => {
  it('hashes matching files at the given commit, not the working tree', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-cache-git-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 't');
      mkdirSync(path.join(dir, 'app/migrations'), { recursive: true });
      writeFileSync(path.join(dir, 'app/migrations/0001.py'), 'one');
      writeFileSync(path.join(dir, 'README.md'), 'readme');
      git('add', '.');
      git('commit', '-qm', 'one');
      const first = git('rev-parse', 'HEAD');
      writeFileSync(path.join(dir, 'README.md'), 'changed');
      git('commit', '-qam', 'readme');
      const second = git('rev-parse', 'HEAD');
      writeFileSync(path.join(dir, 'app/migrations/0002.py'), 'two');
      git('add', '.');
      git('commit', '-qm', 'migration');
      const third = git('rev-parse', 'HEAD');
      // Uncommitted edits must not change the hash.
      writeFileSync(path.join(dir, 'app/migrations/0001.py'), 'dirty');

      const hash = (sha: string) => gitTreeHashFiles(dir, sha)(['**/migrations/*.py']);
      const a = await hash(first);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(await hash(second)).toBe(a); // only an unrelated file changed
      expect(await hash(third)).not.toBe(a); // a migration was added
      expect(await gitTreeHashFiles(dir, third)(['nothing/*.x'])).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeStore(objects: Record<string, number> = {}): CacheStore & {
  objects: Record<string, number>;
} {
  return {
    objects,
    exists: vi.fn(async (k: string) => k in objects),
    newestWithPrefix: vi.fn(async (prefix: string) => {
      const hits = Object.entries(objects).filter(([k]) => k.startsWith(prefix));
      hits.sort((a, b) => b[1] - a[1]);
      return hits[0]?.[0] ?? null;
    }),
    presignGet: vi.fn(async (k: string) => `https://get/${k}`),
    presignPut: vi.fn(async (k: string) => `https://put/${k}`),
  };
}

describe('JobCacheSession', () => {
  const entry: CiCacheEntry = {
    key: 'img-${FINALIZE_HEAD_SHA}',
    paths: ['e2e-images'],
    restoreKeys: ['img-'],
  };
  const prefix = cacheObjectPrefix('org1', 'proj');
  const ctx = (store: CacheStore | null) => ({
    store,
    orgId: 'org1',
    projectId: 'proj',
    env: { FINALIZE_HEAD_SHA: 'abc' },
    hashFiles: noHash,
  });

  it('exact hit restores and then skips the save', async () => {
    const store = fakeStore({ [`${prefix}img-abc`]: 1 });
    const session = new JobCacheSession(ctx(store));
    const restore = await session.restoreEnv(entry);
    expect(restore.AH_CACHE_STATUS).toBe('hit');
    expect(restore.AH_CACHE_URL).toBe(`https://get/${prefix}img-abc`);
    const save = await session.saveEnv(entry);
    expect(save.AH_CACHE_STATUS).toBe('skip');
    expect(store.presignPut).not.toHaveBeenCalled();
  });

  it('falls back to the newest restore-keys match, then saves the exact key', async () => {
    const store = fakeStore({ [`${prefix}img-old`]: 1, [`${prefix}img-newer`]: 2 });
    const session = new JobCacheSession(ctx(store));
    const restore = await session.restoreEnv(entry);
    expect(restore.AH_CACHE_STATUS).toBe('partial');
    expect(restore.AH_CACHE_URL).toBe(`https://get/${prefix}img-newer`);
    const save = await session.saveEnv(entry);
    expect(save).toMatchObject({
      AH_CACHE_STATUS: 'save',
      AH_CACHE_KEY: 'img-abc',
      AH_CACHE_URL: `https://put/${prefix}img-abc`,
    });
  });

  it('a miss saves, unless a sibling saved the key in the meantime', async () => {
    const store = fakeStore();
    const session = new JobCacheSession(ctx(store));
    expect((await session.restoreEnv(entry)).AH_CACHE_STATUS).toBe('miss');
    store.objects[`${prefix}img-abc`] = 5;
    expect((await session.saveEnv(entry)).AH_CACHE_STATUS).toBe('skip');
  });

  it('scopes keys per org and project', async () => {
    const store = fakeStore({ [`${cacheObjectPrefix('other', 'proj')}img-abc`]: 1 });
    const session = new JobCacheSession(ctx(store));
    expect((await session.restoreEnv(entry)).AH_CACHE_STATUS).toBe('miss');
  });

  it('warns instead of restoring an unverified match when the prefix listing is too large', async () => {
    const store = fakeStore();
    store.newestWithPrefix = vi.fn(async () => {
      throw new Error('restore-keys prefix matches more than 50000 cache entries');
    });
    const env = await new JobCacheSession(ctx(store)).restoreEnv(entry);
    expect(env.AH_CACHE_STATUS).toBe('error');
    expect(env.AH_CACHE_URL).toBeUndefined();
    expect(env.AH_CACHE_MESSAGE).toContain('more than 50000');
  });

  it('reports disabled without a store and errors without throwing', async () => {
    expect((await new JobCacheSession(ctx(null)).restoreEnv(entry)).AH_CACHE_STATUS).toBe(
      'disabled',
    );
    const broken = fakeStore();
    broken.exists = vi.fn(async () => {
      throw new Error('AccessDenied');
    });
    const env = await new JobCacheSession(ctx(broken)).restoreEnv(entry);
    expect(env.AH_CACHE_STATUS).toBe('error');
    expect(env.AH_CACHE_MESSAGE).toContain('AccessDenied');
    expect(env.AH_CACHE_URL).toBeUndefined();
  });
});

/**
 * Stand-in for curl against S3: file:// URLs play the bucket. A PUT carrying
 * `If-None-Match: *` is create-only (bash noclobber is an O_EXCL open), so a
 * second writer gets 412 exactly like S3's conditional PUT.
 */
const FAKE_CURL = `#!/usr/bin/env bash
out=; in=; fmt=; cond=0; url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -T) in=$2; shift 2 ;;
    -w) fmt=$2; shift 2 ;;
    -H) [ "$2" = 'If-None-Match: *' ] && cond=1; shift 2 ;;
    -X|--retry|--retry-delay|--connect-timeout|--max-time|--speed-limit|--speed-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
target=\${url#file://}
code() { [ -n "$fmt" ] && printf '%s' "$1"; }
if [ -z "$in" ]; then
  [ -f "$target" ] || { echo "curl: (37) missing $target" >&2; exit 37; }
  cp "$target" "$out"; exit 0
fi
[ -d "$(dirname "$target")" ] || { code 000; exit 7; }
[ "$cond" = 1 ] || { echo "fake curl: unconditional PUT" >&2; code 400; exit 0; }
if ( set -C; cat "$in" > "$target" ) 2>/dev/null; then code 200; else code 412; fi
`;

describe('cache step scripts', () => {
  let binDir = '';
  beforeAll(() => {
    binDir = mkdtempSync(path.join(tmpdir(), 'ci-cache-bin-'));
    writeFileSync(path.join(binDir, 'curl'), FAKE_CURL, { mode: 0o755 });
  });
  afterAll(() => rmSync(binDir, { recursive: true, force: true }));

  const scriptEnv = (env: Record<string, string>) => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    ...env,
  });
  const runScript = (script: string, env: Record<string, string>) =>
    spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: scriptEnv(env),
    });
  const runScriptAsync = (script: string, env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn('bash', ['-euo', 'pipefail', '-c', script], { env: scriptEnv(env) });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.on('close', (status) => resolve({ status, stdout }));
    });

  const entry: CiCacheEntry = {
    key: 'k',
    paths: ['e2e-images', 'testdb-*.dump', 'missing-dir'],
    restoreKeys: [],
  };

  it('round-trips files through save and restore, merging into existing dirs without clobbering', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'ci-cache-scripts-'));
    try {
      const producer = path.join(base, 'producer');
      const consumer = path.join(base, 'consumer');
      const object = path.join(base, 'bucket-object');
      mkdirSync(path.join(producer, 'e2e-images'), { recursive: true });
      mkdirSync(path.join(consumer, 'e2e-images'), { recursive: true });
      writeFileSync(path.join(producer, 'e2e-images/api.tar'), 'api-image');
      writeFileSync(path.join(producer, 'e2e-images/web.tar'), 'web-image');
      writeFileSync(path.join(producer, 'testdb-1.dump'), 'dump');
      writeFileSync(path.join(producer, 'unrelated.txt'), 'not cached');

      const saved = runScript(buildSaveScript(entry, producer), {
        AH_CACHE_STATUS: 'save',
        AH_CACHE_KEY: 'k',
        AH_CACHE_URL: `file://${object}`,
      });
      expect(saved.status).toBe(0);
      expect(saved.stdout).toContain('[cache] saved k');

      writeFileSync(path.join(consumer, 'testdb-1.dump'), 'local wins');
      writeFileSync(path.join(consumer, 'e2e-images/web.tar'), 'local web');
      const restored = runScript(buildRestoreScript(consumer), {
        AH_CACHE_STATUS: 'hit',
        AH_CACHE_MESSAGE: 'restored k',
        AH_CACHE_URL: `file://${object}`,
      });
      expect(restored.status).toBe(0);
      expect(restored.stdout).toContain('[cache] restored k');
      expect(readFileSync(path.join(consumer, 'e2e-images/api.tar'), 'utf8')).toBe('api-image');
      expect(readFileSync(path.join(consumer, 'e2e-images/web.tar'), 'utf8')).toBe('local web');
      expect(readFileSync(path.join(consumer, 'testdb-1.dump'), 'utf8')).toBe('local wins');
      expect(existsSync(path.join(consumer, 'unrelated.txt'))).toBe(false);
      expect(execFileSync('ls', ['-A', consumer], { encoding: 'utf8' })).not.toContain('.ahcache');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('lets exactly one of two concurrent saves of a key win; the other skips', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'ci-cache-race-'));
    try {
      const object = path.join(base, 'bucket-object');
      const producers = ['a', 'b'].map((name) => {
        const dir = path.join(base, name);
        mkdirSync(path.join(dir, 'e2e-images'), { recursive: true });
        writeFileSync(path.join(dir, 'e2e-images/api.tar'), `image-from-${name}`);
        return dir;
      });
      const env = { AH_CACHE_STATUS: 'save', AH_CACHE_KEY: 'k', AH_CACHE_URL: `file://${object}` };

      const results = await Promise.all(
        producers.map((dir) => runScriptAsync(buildSaveScript(entry, dir), env)),
      );

      expect(results.map((r) => r.status)).toEqual([0, 0]);
      const out = results.map((r) => r.stdout).join('\n');
      expect(out.match(/\[cache\] saved k/g)).toHaveLength(1);
      expect(out.match(/saved by another job first/g)).toHaveLength(1);

      // The stored entry is one writer's complete archive, never a mix.
      const consumer = path.join(base, 'consumer');
      mkdirSync(consumer);
      runScript(buildRestoreScript(consumer), {
        AH_CACHE_STATUS: 'hit',
        AH_CACHE_MESSAGE: 'restored k',
        AH_CACHE_URL: `file://${object}`,
      });
      expect(readFileSync(path.join(consumer, 'e2e-images/api.tar'), 'utf8')).toMatch(
        /^image-from-[ab]$/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('concurrent restores on one host keep existing files and never nest directories', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'ci-cache-restore-race-'));
    const slowInstallBin = path.join(base, 'slow-bin');
    mkdirSync(slowInstallBin);
    for (const tool of ['mv', 'cp', 'ln']) {
      const real = execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      writeFileSync(path.join(slowInstallBin, tool), `#!/bin/sh\nsleep 0.4\nexec ${real} "$@"\n`, {
        mode: 0o755,
      });
    }
    try {
      // Two archives with overlapping paths, as two jobs restoring different
      // keys into the same host volume would see.
      const objects = ['a', 'b'].map((name) => {
        const dir = path.join(base, `producer-${name}`);
        mkdirSync(path.join(dir, 'e2e-images/nested'), { recursive: true });
        writeFileSync(path.join(dir, 'e2e-images/api.tar'), `api-from-${name}`.repeat(5000));
        writeFileSync(path.join(dir, 'e2e-images/nested/db.tar'), `db-from-${name}`.repeat(5000));
        writeFileSync(path.join(dir, 'e2e-images/existing.tar'), `remote-${name}`);
        // Top-level paths the host does not have yet: the first restore to
        // install them must not be overwritten or nested into by the second.
        mkdirSync(path.join(dir, 'missing-dir'));
        writeFileSync(path.join(dir, 'missing-dir/bin'), `bin-from-${name}`.repeat(5000));
        writeFileSync(path.join(dir, 'testdb-1.dump'), `dump-from-${name}`.repeat(5000));
        const object = path.join(base, `object-${name}`);
        const saved = runScript(buildSaveScript(entry, dir), {
          AH_CACHE_STATUS: 'save',
          AH_CACHE_KEY: name,
          AH_CACHE_URL: `file://${object}`,
        });
        expect(saved.stdout).toContain(`saved ${name}`);
        return object;
      });

      for (let round = 0; round < 2; round++) {
        const root = path.join(base, `host-${round}`);
        mkdirSync(path.join(root, 'e2e-images'), { recursive: true });
        writeFileSync(path.join(root, 'e2e-images/existing.tar'), 'already on host');

        // Both restores pass any existence check before either installs:
        // install tools are shimmed to pause first, forcing the interleaving.
        const results = await Promise.all(
          objects.map((object) =>
            runScriptAsync(buildRestoreScript(root), {
              AH_CACHE_STATUS: 'hit',
              AH_CACHE_MESSAGE: 'restored',
              AH_CACHE_URL: `file://${object}`,
              PATH: `${slowInstallBin}:${binDir}:${process.env.PATH ?? ''}`,
            }),
          ),
        );

        expect(results.map((r) => r.status)).toEqual([0, 0]);
        expect(readFileSync(path.join(root, 'e2e-images/existing.tar'), 'utf8')).toBe(
          'already on host',
        );
        expect(existsSync(path.join(root, 'e2e-images/e2e-images'))).toBe(false);
        expect(existsSync(path.join(root, 'e2e-images/nested/nested'))).toBe(false);
        expect(
          execFileSync('ls', ['-A', path.join(root, 'missing-dir')], { encoding: 'utf8' }).trim(),
        ).toBe('bin');
        expect(readFileSync(path.join(root, 'missing-dir/bin'), 'utf8')).toMatch(
          /^(?:(?:bin-from-a){5000}|(?:bin-from-b){5000})$/,
        );
        // A top-level file is one restore's complete copy.
        const winner = readFileSync(path.join(root, 'testdb-1.dump'), 'utf8').slice(10, 11);
        expect(readFileSync(path.join(root, 'testdb-1.dump'), 'utf8')).toBe(
          `dump-from-${winner}`.repeat(5000),
        );
        // Each installed file is one archive's complete copy, never a mix.
        expect(readFileSync(path.join(root, 'e2e-images/api.tar'), 'utf8')).toMatch(
          /^(?:(?:api-from-a){5000}|(?:api-from-b){5000})$/,
        );
        expect(readFileSync(path.join(root, 'e2e-images/nested/db.tar'), 'utf8')).toMatch(
          /^(?:(?:db-from-a){5000}|(?:db-from-b){5000})$/,
        );
        expect(execFileSync('ls', ['-A', root], { encoding: 'utf8' }).trim().split('\n')).toEqual([
          'e2e-images',
          'missing-dir',
          'testdb-1.dump',
        ]);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never fails the job on a transfer error, miss, or skip', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ci-cache-fail-'));
    try {
      mkdirSync(path.join(root, 'e2e-images'));
      writeFileSync(path.join(root, 'e2e-images/x'), 'x');
      const badRestore = runScript(buildRestoreScript(root), {
        AH_CACHE_STATUS: 'hit',
        AH_CACHE_URL: `file://${root}/does-not-exist`,
      });
      expect(badRestore.status).toBe(0);
      expect(badRestore.stdout).toContain('warning: download failed');

      const badSave = runScript(buildSaveScript(entry, root), {
        AH_CACHE_STATUS: 'save',
        AH_CACHE_URL: `file:///nonexistent-dir-${process.pid}/obj`,
      });
      expect(badSave.status).toBe(0);
      expect(badSave.stdout).toContain('warning: upload failed (HTTP 000)');

      const miss = runScript(buildRestoreScript(root), {
        AH_CACHE_STATUS: 'miss',
        AH_CACHE_MESSAGE: 'miss: no cache entry for k',
      });
      expect(miss.status).toBe(0);
      expect(miss.stdout).toContain('[cache] miss: no cache entry for k');

      const skip = runScript(buildSaveScript(entry, root), {
        AH_CACHE_STATUS: 'skip',
        AH_CACHE_MESSAGE: 'k was restored from an exact hit; not saving again',
      });
      expect(skip.status).toBe(0);
      expect(skip.stdout).toContain('not saving again');
      expect(execFileSync('ls', ['-A', root], { encoding: 'utf8' }).trim()).toBe('e2e-images');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds every transfer and sends the conditional header, with no URL in the script text', () => {
    const save = buildSaveScript(entry);
    const restore = buildRestoreScript();
    for (const script of [save, restore]) {
      expect(script).not.toMatch(/https?:/);
      expect(script).toMatch(/--max-time \d+/);
      expect(script).toMatch(/--speed-limit \d+ --speed-time \d+/);
    }
    expect(save).toContain("-H 'If-None-Match: *'");
    expect(save).toContain('"$AH_CACHE_URL"');
  });
});

describe('boundedCacheSetup', () => {
  function cancelSource() {
    let listener: (() => void) | null = null;
    const cancel = {
      aborted: false,
      onAbort(l: () => void) {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    return {
      cancel,
      fire() {
        cancel.aborted = true;
        listener?.();
      },
    };
  }

  it('turns a setup that never settles into a warning once the deadline passes', async () => {
    let seen: AbortSignal | undefined;
    const outcome = await boundedCacheSetup(
      (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 20 },
    );
    expect(outcome).toEqual({
      kind: 'env',
      env: expect.objectContaining({
        AH_CACHE_STATUS: 'error',
        AH_CACHE_MESSAGE: expect.stringContaining('timed out'),
      }),
    });
    expect(seen?.aborted).toBe(true); // the stalled work is told to stop
  });

  it('resolves promptly as cancelled when the run is stopped mid-lookup', async () => {
    const { cancel, fire } = cancelSource();
    let seen: AbortSignal | undefined;
    const pending = boundedCacheSetup(
      (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 60_000, cancel },
    );
    setTimeout(fire, 10);
    const started = Date.now();
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen?.aborted).toBe(true);
  });

  it('does not start setup when already cancelled, and reports setup errors as warnings', async () => {
    const { cancel, fire } = cancelSource();
    fire();
    const setup = vi.fn(async () => ({}));
    expect(await boundedCacheSetup(setup, { cancel })).toEqual({ kind: 'cancelled' });
    expect(setup).not.toHaveBeenCalled();

    const failed = await boundedCacheSetup(
      async () => {
        throw new Error('credentials unavailable');
      },
      { timeoutMs: 1000 },
    );
    expect(failed.kind === 'env' && failed.env.AH_CACHE_MESSAGE).toContain(
      'credentials unavailable',
    );
  });

  it('passes the setup signal through to store lookups', async () => {
    const store = {
      exists: vi.fn(async (_k: string, _s?: AbortSignal) => false),
      newestWithPrefix: vi.fn(async (_k: string, _s?: AbortSignal) => null),
      presignGet: vi.fn(async () => ''),
      presignPut: vi.fn(async () => ''),
    };
    const session = new JobCacheSession({
      store,
      env: {},
      hashFiles: async () => 'h',
    });
    const ac = new AbortController();
    await session.restoreEnv({ key: 'k', paths: ['a'], restoreKeys: ['k-'] }, ac.signal);
    expect(store.exists.mock.calls[0][1]).toBe(ac.signal);
    expect(store.newestWithPrefix.mock.calls[0][1]).toBe(ac.signal);
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The packaged .app boots the embedded server with tsx straight from source,
 * so every directory the server imports from must (a) be shipped by
 * electron-builder's `files` list and (b) be in `asarUnpack` — tsx reads the
 * files from disk and cannot see inside `app.asar`.
 *
 * Regression: the server grew `../shared/utils/*` imports but only
 * `electron/`, `server/`, and `client/dist/` were packaged, so the DMG built
 * green in CI and then crashed at launch with
 * `ERR_MODULE_NOT_FOUND ... app.asar.unpacked/shared/utils/sessionAutopilot.js`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');

interface BuildConfig {
  files: string[];
  asarUnpack: string[];
}

function readBuildConfig(): BuildConfig {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    build?: Partial<BuildConfig>;
  };
  return {
    files: pkg.build?.files ?? [],
    asarUnpack: pkg.build?.asarUnpack ?? [],
  };
}

function walkTsSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'test' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsSources(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Matches `from '../x'`, `import('../x')`, and `export ... from '../x'`.
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"]((?:\.\.\/)+[^'"]+)['"]/g;

/** Drop `//` and `/* * ... *\/` comment lines so doc-comment import examples don't count. */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** Top-level repo directories (relative to ROOT) that server source imports from, other than server/. */
export function externalDirsImportedByServer(): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const file of walkTsSources(SERVER_DIR)) {
    const src = stripCommentLines(readFileSync(file, 'utf8'));
    for (const match of src.matchAll(RELATIVE_IMPORT)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const rel = path.relative(ROOT, target);
      if (rel.startsWith('..')) continue;
      const topDir = rel.split(path.sep)[0];
      if (topDir === 'server') continue;
      const list = byDir.get(topDir) ?? [];
      list.push(path.relative(ROOT, file));
      byDir.set(topDir, list);
    }
  }
  return byDir;
}

/** True when some non-negated pattern in `patterns` covers `dir/`. */
function coversDir(patterns: string[], dir: string): boolean {
  return patterns.some((p) => !p.startsWith('!') && (p === dir || p.startsWith(`${dir}/`)));
}

describe('electron-builder packaging covers every directory the server imports', () => {
  const build = readBuildConfig();
  const external = externalDirsImportedByServer();

  it('server source currently imports from shared/ (sanity check for this guard)', () => {
    expect([...external.keys()]).toContain('shared');
  });

  for (const [dir, importers] of external) {
    it(`ships ${dir}/ in build.files (imported by ${importers.length} server file(s))`, () => {
      expect(
        coversDir(build.files, dir),
        `"${dir}/**/*" is missing from build.files in package.json; first importer: ${importers[0]}`,
      ).toBe(true);
    });

    it(`unpacks ${dir}/ from app.asar so tsx can read it at runtime`, () => {
      expect(
        coversDir(build.asarUnpack, dir),
        `"${dir}/**/*" is missing from build.asarUnpack in package.json; first importer: ${importers[0]}`,
      ).toBe(true);
    });
  }
});

/**
 * better-sqlite3 is native. electron-builder's `@electron/rebuild` only
 * rebuilds the ROOT `node_modules/better-sqlite3` for Electron's Node ABI;
 * `server/node_modules/better-sqlite3` stays compiled for the system Node
 * used by `npm ci`. Because the server resolves its own copy first, shipping
 * it means the packaged app dies at boot with
 * `ERR_DLOPEN_FAILED ... NODE_MODULE_VERSION 127 ... requires 145` the
 * moment Electron's bundled Node diverges from the dev Node. Excluding the
 * server copy lets resolution fall through to the Electron-rebuilt root copy.
 */
describe('electron-builder packaging ships only the Electron-rebuilt better-sqlite3', () => {
  const build = readBuildConfig();
  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const serverPkg = JSON.parse(readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };

  it('excludes server/node_modules/better-sqlite3 from build.files', () => {
    expect(build.files).toContain('!server/node_modules/better-sqlite3/**');
  });

  it('unpacks the root better-sqlite3 (and its loader deps) so the server can dlopen it', () => {
    expect(build.asarUnpack).toContain('node_modules/better-sqlite3/**/*');
    expect(build.asarUnpack).toContain('node_modules/bindings/**/*');
    expect(build.asarUnpack).toContain('node_modules/file-uri-to-path/**/*');
  });

  it('declares better-sqlite3 at the root on the same major as the server', () => {
    const rootSpec = rootPkg.dependencies?.['better-sqlite3'];
    const serverSpec = serverPkg.dependencies?.['better-sqlite3'];
    expect(
      rootSpec,
      'root package.json must depend on better-sqlite3 for @electron/rebuild',
    ).toBeTruthy();
    expect(serverSpec).toBeTruthy();
    const major = (spec: string) => spec.replace(/^[\^~]/, '').split('.')[0];
    expect(major(rootSpec!)).toBe(major(serverSpec!));
  });
});

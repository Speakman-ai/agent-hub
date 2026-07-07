/**
 * Self-heal the `better-sqlite3` native addon when it was compiled against a
 * different Node.js ABI than the one now running.
 *
 * Why this exists: `verify-node-version.mjs` only asserts the Node *version* is
 * in range — it can't catch a `better-sqlite3` build left over from a previous
 * Node version (the classic `ERR_DLOPEN_FAILED … NODE_MODULE_VERSION 115 vs
 * 127`). That crash recurs every time you switch Node versions (nvm) and then
 * `npm run dev`. Rather than make the developer remember `npm run rebuild:native`,
 * we detect the mismatch here and rebuild automatically.
 *
 * The server loads its OWN copy (`server/node_modules/better-sqlite3`) because
 * it runs from `server/`, so BOTH the root and the server installs must match
 * the running ABI — we check and rebuild each independently.
 */
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Package dirs that ship their own better-sqlite3 build. Keep in sync with the
// `rebuild:native` script.
const targets = [root, path.join(root, 'server')];

/** True when better-sqlite3 in `dir` loads under the current Node ABI. */
function loadsCleanly(dir) {
  const modPath = path.join(dir, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(modPath)) return true; // nothing installed here → not our problem
  try {
    const require = createRequire(path.join(dir, 'package.json'));
    const Database = require('better-sqlite3');
    // Actually open an in-memory DB so the native addon is dlopen'd, not just
    // the JS wrapper — a stale .node only fails at dlopen time.
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

// CRITICAL: rebuild with the SAME Node that's running this script, not whatever
// `npm` happens to be first on PATH. A bare `npm rebuild` resolves npm (and the
// node it spawns for node-gyp) from PATH, which frequently points at a
// DIFFERENT Node version than the one about to run the dev server — that is the
// exact footgun that makes this crash recur. We locate the npm-cli.js that
// ships with `process.execPath` and run it via that same binary, and prepend
// its bin dir to PATH so any nested node-gyp spawn also matches.
const nodeBinDir = path.dirname(process.execPath);
const npmCli = path.resolve(nodeBinDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const childEnv = { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}` };

function rebuild(dir) {
  if (fs.existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
      cwd: dir,
      stdio: 'inherit',
      env: childEnv,
    });
    return;
  }
  // Fallback: bare npm, but with the running Node's bin dir first on PATH.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['rebuild', 'better-sqlite3'], { cwd: dir, stdio: 'inherit', env: childEnv });
}

let rebuilt = false;

for (const dir of targets) {
  if (loadsCleanly(dir)) continue;
  rebuilt = true;
  const rel = path.relative(root, dir) || '.';
  console.error(
    `[native] better-sqlite3 in ${rel} is stale for Node ${process.version} (ABI ${process.versions.modules}). Rebuilding…`,
  );
  try {
    rebuild(dir);
  } catch {
    console.error('');
    console.error(`[native] Automatic rebuild failed in ${rel}. Run it manually:`);
    console.error(`  (cd ${rel} && npm rebuild better-sqlite3)`);
    console.error('');
    process.exit(1);
  }
}

if (rebuilt) console.error('[native] better-sqlite3 rebuilt for the current Node version.');

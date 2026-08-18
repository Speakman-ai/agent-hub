/**
 * Self-heal the native addons the Hub depends on so a fresh install / Node
 * switch doesn't leave the app broken.
 *
 * Two independent concerns:
 *
 * 1. `better-sqlite3` (hard dependency): rebuilt when it was compiled against a
 *    different Node ABI than the one now running (the classic
 *    `ERR_DLOPEN_FAILED … NODE_MODULE_VERSION 115 vs 127`). `better-sqlite3`
 *    ships prebuilds via prebuild-install, so this only bites after an nvm
 *    switch; the rebuild covers that.
 *
 * 2. `node-pty` (OPTIONAL dependency, Terminal only): node-pty publishes no
 *    linux-x64 prebuild, so on a host without a C toolchain (`make` + a C++
 *    compiler) its install script fails. It is declared under
 *    `optionalDependencies` precisely so that failure does NOT abort
 *    `npm install` — the package is simply omitted and every import site
 *    lazy-loads it and degrades gracefully (only the Terminal is affected).
 *    Here we opportunistically heal it by copying a *compatible* prebuilt
 *    `node-pty` from a donor install already present on the host (e.g. the
 *    `/app` image the Hub itself runs from), so the Terminal keeps working in
 *    session worktrees that can't compile it.
 *
 * The server loads its OWN copies (it runs from `server/`), so both the root
 * and the server installs are checked independently.
 */
import { createRequire } from 'module';
import { execFileSync, spawnSync } from 'child_process';
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
const childEnv = {
  ...process.env,
  PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
};

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

/** Heal stale better-sqlite3 builds. Returns true if anything was rebuilt. */
function healBetterSqlite() {
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
  return rebuilt;
}

// --- node-pty (optional, Terminal only) ------------------------------------

export const NODE_PTY_MODULE_REL = path.join('node_modules', 'node-pty');

function defaultRun(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore' });
}

/**
 * True when the node-pty install at `dir` loads under the CURRENT Node ABI.
 * Probed in a child process so a foreign-platform or ABI-mismatched `pty.node`
 * can't crash this one — a bad `.node` only fails at dlopen time.
 */
export function nodePtyLoads(dir, run = defaultRun) {
  if (!dir || !fs.existsSync(path.join(dir, 'package.json'))) return false;
  const res = run(process.execPath, ['-e', `require(${JSON.stringify(dir)})`]);
  return res != null && res.status === 0;
}

/**
 * Pick the first donor whose node-pty loads cleanly under this Node. Pure — the
 * caller injects `probe(dir) -> boolean` so this is unit-testable without a
 * filesystem.
 */
export function selectNodePtyDonor(candidateDirs, probe) {
  for (const dir of candidateDirs) {
    if (probe(dir)) return dir;
  }
  return null;
}

/** Candidate donor node-pty module dirs, most-preferred first. */
export function nodePtyDonorCandidates(env = process.env) {
  const out = [];
  if (env.AGENT_HUB_NODE_PTY_DONOR) out.push(env.AGENT_HUB_NODE_PTY_DONOR);
  // The Hub image compiles node-pty at build time and runs from /app, so its
  // copy is an ABI-matched donor for session worktrees on the same host.
  out.push(path.join('/app', 'server', NODE_PTY_MODULE_REL));
  return out;
}

/** Default module-copy: replace `target` with a recursive copy of `donor`. */
export function copyNodePtyModule(donor, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(donor, target, { recursive: true, dereference: true });
}

/**
 * Ensure the server's node-pty is present and loadable, copying a compatible
 * prebuilt from a donor when the local install is missing or unbuildable.
 * Returns true if a heal copy was performed.
 *
 * All I/O seams are injectable so the workflow is unit-testable against a
 * temporary filesystem without a real native module:
 *   - `target`     — the node-pty dir to heal (default: server install).
 *   - `candidates` — donor dirs to consider (default: host donors).
 *   - `loads`      — probe `dir -> boolean` for "loads under this Node ABI".
 *   - `copyModule` — `(donor, target) -> void`; throws on copy failure.
 *   - `log`        — sink for progress/warning lines (default console.error).
 */
export function healNodePty(opts = {}) {
  const target = opts.target ?? path.join(root, 'server', NODE_PTY_MODULE_REL);
  const loads = opts.loads ?? ((d) => nodePtyLoads(d));
  const copyModule = opts.copyModule ?? copyNodePtyModule;
  const log = opts.log ?? console.error;
  const candidates = (opts.candidates ?? nodePtyDonorCandidates()).filter(
    (d) => path.resolve(d) !== path.resolve(target),
  );

  if (loads(target)) return false; // already working

  const donor = selectNodePtyDonor(candidates, loads);
  if (!donor) {
    log(
      '[native] node-pty is unavailable and no ABI-compatible prebuilt donor was found. ' +
        'The Terminal will be disabled; every other feature works. ' +
        'Install a C toolchain (make + a C++ compiler) and re-run `npm --prefix server install` to build it.',
    );
    return false;
  }

  try {
    copyModule(donor, target);
  } catch (err) {
    log(`[native] Failed to copy node-pty from ${donor}: ${err?.message ?? err}`);
    return false;
  }

  if (!loads(target)) {
    log(`[native] Copied node-pty from ${donor} but it still fails to load.`);
    return false;
  }
  log(`[native] Healed node-pty by copying an ABI-compatible prebuilt from ${donor}.`);
  return true;
}

function main() {
  healBetterSqlite();
  healNodePty();
}

// Only run side effects when executed directly (`node scripts/ensure-native-modules.mjs`),
// not when imported by a test.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();

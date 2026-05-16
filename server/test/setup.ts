import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { promisify } from 'util';

// Per-FILE isolation. vitest invokes setupFiles before each test file is
// imported, so by overriding AGENT_HUB_DATA_DIR to a fresh random subdir
// here, every test file's first import of server/config.ts (which reads
// the env var at module load) sees a unique on-disk location. This is
// what lets `pool: 'forks'` + `isolate: true` run in parallel without
// leaking SQLite databases, projects.json, auth.json, etc. across files.
//
// Note: vitest forks reuse OS processes across files within a worker,
// so process.pid is NOT unique per file. The randomUUID subdir below is.
//
// vitest.config.ts seeded AGENT_HUB_DATA_DIR to a per-process base under
// os.tmpdir() — we nest one more level under it so cleanup is bounded and
// the safety rail in server/config.ts (which refuses to run tests pointing
// at the production data dir) still passes.
const BASE_DIR =
  process.env.AGENT_HUB_DATA_DIR ?? path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);
const TEST_DATA_DIR = path.join(BASE_DIR, `file-${crypto.randomUUID()}`);

// Defence-in-depth: never let a test write outside os.tmpdir().
if (!TEST_DATA_DIR.startsWith(os.tmpdir())) {
  throw new Error(
    `[test/setup] AGENT_HUB_DATA_DIR must live under ${os.tmpdir()} for tests. Got: ${TEST_DATA_DIR}`,
  );
}

// Override BEFORE the test file body imports anything from server/.
process.env.AGENT_HUB_DATA_DIR = TEST_DATA_DIR;
delete process.env.AGENT_HUB_API_KEY;
// Fresh deploy bootstrap env must not leak from the host (Agent Hub
// sessions, Docker, Terraform shells). If set, maybeAutoProvisionOwner runs at
// server boot, auth.json exists, and authMiddleware rejects unauthenticated
// API calls — most integration tests expect the legacy "no auth configured"
// open gate unless they attach Bearer tokens explicitly.
delete process.env.AGENT_HUB_DEFAULT_PASSWORD;
delete process.env.AGENT_HUB_DEFAULT_USERNAME;
// Deploy URL overrides in config.json must not leak from the host; tests
// write their own config.json and expect env not to win.
delete process.env.AGENT_HUB_PUBLIC_URL;
delete process.env.AGENT_HUB_AGENT_URL;
delete process.env.AGENT_HUB_CODEX_DANGER_BYPASS;

// ─── Hard guard: tests must never spawn the real CLI binaries ────────────────
// History: tests that didn't mock `child_process` were spawning real `claude`
// children that never got reaped — they reparented to init, accumulated to
// ~20 instances holding ~250MB RSS each, and put the prod box into a swap
// death spiral. See CLAUDE.md "Testing — never spawn real CLI binaries".
//
// Two layers of protection:
//   1. Point CLAUDE_BIN / CURSOR_BIN / GEMINI_BIN / CODEX_BIN at a stub that
//      exits non-zero with a loud pointer to the fix. server/config.ts's
//      pickBin() prefers env-var paths when they exist, so this catches every
//      `spawn(claudeBin, ...)` site in the codebase.
//   2. Monkey-patch child_process.{spawn,spawnSync,execFile,execFileSync} via
//      the underlying CJS exports object so any DIRECT spawn('claude', ...)
//      that bypasses config also throws synchronously with a clear message.
//
// Tests that legitimately mock child_process (vi.mock) get their own mock
// and bypass this guard entirely — that's intended.
const SETUP_DIR = path.dirname(fileURLToPath(import.meta.url));
const NO_REAL_CLI = path.join(SETUP_DIR, 'fixtures', 'no-real-cli-in-tests.sh');
process.env.CLAUDE_BIN = NO_REAL_CLI;
process.env.CURSOR_BIN = NO_REAL_CLI;
process.env.GEMINI_BIN = NO_REAL_CLI;
process.env.CODEX_BIN = NO_REAL_CLI;

const FORBIDDEN_BIN_RE = /(?:^|[/\\])(claude|claude-code|cursor-agent|gemini|codex)(?:\.exe)?$/i;

function makeGuard<T extends (...args: unknown[]) => unknown>(name: string, original: T): T {
  const wrapped = ((...args: unknown[]) => {
    const cmd = typeof args[0] === 'string' ? args[0] : '';
    if (cmd && FORBIDDEN_BIN_RE.test(cmd)) {
      throw new Error(
        `[test/setup] child_process.${name}(${JSON.stringify(cmd)}, ...) is forbidden in tests.\n` +
          `Tests must NEVER spawn the real claude/cursor/codex/gemini CLI binary.\n` +
          `Mock child_process (vi.mock('child_process', ...)) OR the wrapper that calls it,\n` +
          `e.g. vi.mock('./heartbeat.js', () => ({ runClaude: vi.fn() })).\n` +
          `See CLAUDE.md "Testing — never spawn real CLI binaries in tests".`,
      );
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as T;
  // Preserve util.promisify.custom so `promisify(execFile)` keeps its
  // documented `{ stdout, stderr }` resolution shape. Without this, the
  // generic callback-based promisify takes over and resolves to just the
  // raw stdout string — breaking every caller that destructures the result
  // (e.g. worktree.ts's runGit uses `const { stdout } = await execFileP(...)`,
  // which would then read `.stdout` off a string and throw).
  const customSym = (promisify as unknown as { custom: symbol }).custom;
  const customImpl = (original as unknown as Record<symbol, unknown>)[customSym];
  if (typeof customImpl === 'function') {
    (wrapped as unknown as Record<symbol, unknown>)[customSym] = customImpl;
  }
  return wrapped;
}

// child_process is a CJS module; require it via createRequire so we can mutate
// the exports object directly. ESM `import * as cp` would give us a frozen
// namespace, and reassignments to it would be silent no-ops.
const requireCjs = createRequire(import.meta.url);
const cp = requireCjs('child_process');
cp.spawn = makeGuard('spawn', cp.spawn);
cp.spawnSync = makeGuard('spawnSync', cp.spawnSync);
cp.execFile = makeGuard('execFile', cp.execFile);
cp.execFileSync = makeGuard('execFileSync', cp.execFileSync);

mkdirSync(TEST_DATA_DIR, { recursive: true });
writeFileSync(path.join(TEST_DATA_DIR, 'projects.json'), '[]');

// PR-env kill switch is ON in production (epic 88367984) — every PR-env
// code path short-circuits. PR-Env Removal #4 has now deleted the
// remaining backing code (the PR-env subsystem directory, three crons,
// and W4 observability routes), so the killswitch's last in-process
// consumer is the `features.prEnv` flag served by `/api/config`. We
// still flip it OFF here so any pre-existing test that imports the
// flag indirectly sees the historical "feature available" shape — the
// dedicated killswitch test (`server/pr-env-killswitch.test.ts`) flips
// it back on for the assertions that prove the production gate fires.
//
// Imported lazily so the module's module-level state is reset for every
// test file (per-FILE isolation matches the rest of this setup).
await import('../pr-env-killswitch.js').then((mod) => {
  mod.__setPrEnvKillSwitchForTests(false);
});

afterAll(() => {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

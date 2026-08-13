/**
 * Guest-side agent CLI spawn helpers for env-owned SessionEnv backends
 * (Firecracker).
 *
 * Host `child_process.spawn` against `session.worktree_path` would write a
 * second, divergent tree. Chat turns must run inside the env via
 * {@link SessionEnv.spawn}, with Linux CLIs available in the guest (baked into
 * the rootfs and/or installed on first use) and host-absolute paths remapped.
 *
 * Runtime state (CLI HOME, bundled skills, prompts, git/gh guard shims) lives
 * **outside** the git worktree under {@link GUEST_RUNTIME_ROOT} so `git add -A`
 * cannot commit credentials or Hub scaffolding into the session branch.
 */

import { spawnSync } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDefaultSkillsDir } from '../config.js';
import type { SessionEnv } from './session-env.js';
import { FIRECRACKER_GUEST_WORKSPACE } from './firecracker/firecracker-vm-args.js';

/** Single-quote for `sh -c` (same form as GuestWorktreeIo). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildGuestCliCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(shellQuote).join(' ');
}

/**
 * Map a host absolute cwd under the seed worktree to a worktree-relative path
 * for {@link SessionEnv.spawn}.
 */
export function hostCwdToWorktreeRelative(hostCwd: string, hostWorktree: string): string {
  const absCwd = path.resolve(hostCwd);
  const absRoot = path.resolve(hostWorktree);
  const rel = path.relative(absRoot, absCwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Spawn cwd ${hostCwd} is outside the session worktree ${hostWorktree}; ` +
        `env-owned CLI turns must stay inside the guest worktree.`,
    );
  }
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/**
 * Absolute guest paths outside `/workspace` (the mounted git worktree).
 * finalize-runner uses uid 1000 as `runner`.
 */
export const GUEST_RUNTIME_ROOT = '/home/runner/.agent-hub-runtime';
export const GUEST_CLI_HOME = `${GUEST_RUNTIME_ROOT}/cli-home`;
export const GUEST_SKILLS_ROOT = `${GUEST_RUNTIME_ROOT}/bundled-skills`;
export const GUEST_PROMPTS_DIR = `${GUEST_RUNTIME_ROOT}/prompts`;
export const GUEST_SPAWN_GUARDS_DIR = `${GUEST_RUNTIME_ROOT}/spawn-guards`;

const HOST_SPAWN_GUARDS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../finalize/spawn-guards',
);

/** Engine → guest install command (Linux). Used when the bin is missing. */
export const GUEST_CLI_INSTALL_BY_ENGINE: Record<
  string,
  { binName: string; installCommand: string }
> = {
  'claude-code': {
    binName: 'claude',
    // Prefer the native installer (user-local); npm -g needs root on many images.
    installCommand:
      'curl -fsSL https://claude.ai/install.sh | bash || ' +
      'npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code',
  },
  'gemini-cli': {
    binName: 'gemini',
    installCommand: 'npm install -g --prefix "$HOME/.local" @google/gemini-cli',
  },
  'codex-cli': {
    binName: 'codex',
    installCommand:
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh || ' +
      'npm install -g --prefix "$HOME/.local" @openai/codex',
  },
  'cursor-agent': {
    binName: 'agent',
    installCommand: 'curl -fsSL https://cursor.com/install | bash',
  },
  'grok-cli': {
    binName: 'grok',
    installCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  },
};

type GuestAbsWriter = {
  writeGuestFile?(guestPath: string, contents: Buffer, opts?: { mode?: string }): Promise<void>;
};

async function writeAbsGuestFile(
  env: SessionEnv,
  absPath: string,
  contents: Buffer | string,
  opts: { mode?: string } = {},
): Promise<void> {
  const buf = typeof contents === 'string' ? Buffer.from(contents) : contents;
  const writer = env as SessionEnv & GuestAbsWriter;
  if (typeof writer.writeGuestFile === 'function') {
    await writer.writeGuestFile(absPath, buf, opts);
    return;
  }
  // Fallback for adapters without an absolute write: base64 via shell.
  const dir = path.posix.dirname(absPath);
  const b64 = buf.toString('base64');
  const mode = opts.mode ? ` && chmod ${opts.mode} ${shellQuote(absPath)}` : '';
  const result = await env.worktreeIo.exec(
    `mkdir -p ${shellQuote(dir)} && printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(absPath)}${mode}`,
    { cwd: '.', timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to write guest file ${absPath}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

async function mkdirAbsGuest(env: SessionEnv, absPath: string): Promise<void> {
  const result = await env.worktreeIo.exec(`mkdir -p ${shellQuote(absPath)}`, { cwd: '.' });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to mkdir ${absPath}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function absExistsInGuest(env: SessionEnv, absPath: string): Promise<boolean> {
  const result = await env.worktreeIo.exec(`test -e ${shellQuote(absPath)}`, { cwd: '.' });
  return result.exitCode === 0;
}

/**
 * Remap host spawn env for a guest CLI turn: guest HOME, drop host-only
 * absolute paths that would confuse Linux guests. PATH is filled in by
 * {@link finalizeGuestSpawnEnv} after skill script dirs are known.
 */
export function adaptSpawnEnvForGuest(
  hostEnv: NodeJS.ProcessEnv,
  opts: { guestHome: string; guestSkillsRoot: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (key === 'PATH') continue;
    if (key === 'HOME' || key === 'CODEX_HOME') continue;
    if (key === 'AGENT_HUB_SKILLS_DIR' || key === 'AGENT_HUB_DATA_DIR') continue;
    // Host-absolute credential / config paths are unreachable in the guest.
    if (
      (key.endsWith('_FILE') || key.endsWith('_PATH') || key.endsWith('_DIR')) &&
      value.startsWith('/') &&
      !value.startsWith(FIRECRACKER_GUEST_WORKSPACE) &&
      !value.startsWith(GUEST_RUNTIME_ROOT)
    ) {
      continue;
    }
    out[key] = value;
  }

  out.HOME = opts.guestHome;
  out.AGENT_HUB_SKILLS_DIR = path.posix.join(opts.guestSkillsRoot, 'agent-hub');
  // Point guard shims at guest binaries (host AGENT_HUB_REAL_* paths are useless).
  out.AGENT_HUB_REAL_GIT = '/usr/bin/git';
  out.AGENT_HUB_REAL_GH = '/usr/bin/gh';
  // Cursor Agent may prefer the OS keychain on some hosts; guests have none.
  // Force the file store so synced `$HOME/.cursor/auth.json` / `cli-config.json`
  // (and `CURSOR_API_KEY`) are what the CLI actually uses.
  out.AGENT_CLI_CREDENTIAL_STORE = 'file';
  return out;
}

/**
 * Same as {@link adaptSpawnEnvForGuest} but with concrete skill script PATH
 * entries discovered after staging, plus spawn-guard shims first on PATH.
 */
export function finalizeGuestSpawnEnv(
  base: Record<string, string>,
  skillScriptDirs: string[],
  guestHome: string,
  opts: { spawnGuardsDir?: string } = {},
): Record<string, string> {
  const localBin = `${guestHome}/.local/bin`;
  const guards = opts.spawnGuardsDir ?? GUEST_SPAWN_GUARDS_DIR;
  const pathParts = [
    guards,
    localBin,
    ...skillScriptDirs,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  return { ...base, PATH: pathParts.join(':') };
}

export async function writeGuestSystemPromptFile(
  env: SessionEnv,
  sessionId: string,
  enrichedPrompt: string,
): Promise<{ guestPath: string; cleanup: () => Promise<void> }> {
  await mkdirAbsGuest(env, GUEST_PROMPTS_DIR);
  const abs = `${GUEST_PROMPTS_DIR}/${sessionId.slice(0, 8)}-${Date.now()}-system-prompt.md`;
  await writeAbsGuestFile(env, abs, enrichedPrompt);
  return {
    guestPath: abs,
    cleanup: async () => {
      try {
        await env.worktreeIo.exec(`rm -f ${shellQuote(abs)}`, { cwd: '.' });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Places a prior install (or a baked rootfs binary) may live. `command -v`
 * alone is not enough: guest `exec` uses a minimal PATH that omits
 * `~/.local/bin`, so every chat turn was re-running the multi-minute curl
 * install even after a successful first install.
 */
export function guestEngineBinCandidates(binName: string, guestHome: string): string[] {
  const local = path.posix.join(guestHome, '.local', 'bin', binName);
  const runnerLocal = path.posix.join('/home/runner', '.local', 'bin', binName);
  const candidates = [
    local,
    runnerLocal,
    path.posix.join('/usr/local', 'bin', binName),
    path.posix.join('/usr', 'bin', binName),
  ];
  // Cursor's installer also exposes `cursor-agent`; Grok may steal `agent`.
  if (binName === 'agent') {
    candidates.unshift(
      path.posix.join(guestHome, '.local', 'bin', 'cursor-agent'),
      path.posix.join('/home/runner', '.local', 'bin', 'cursor-agent'),
    );
  }
  candidates.push(binName);
  return candidates;
}

async function locateGuestEngineBin(
  env: SessionEnv,
  binName: string,
  guestHome: string,
): Promise<string | null> {
  // Prefer explicit candidates (Cursor's `cursor-agent` before a Grok-stolen
  // `agent` shim) before trusting a bare `command -v`.
  for (const candidate of guestEngineBinCandidates(binName, guestHome)) {
    if (!candidate.startsWith('/')) continue;
    if (await absExistsInGuest(env, candidate)) {
      const exe = await env.worktreeIo.exec(`test -x ${shellQuote(candidate)}`, { cwd: '.' });
      if (exe.exitCode === 0) return candidate;
    }
  }

  const pathPrefix = [
    path.posix.join(guestHome, '.local', 'bin'),
    '/home/runner/.local/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  const which = await env.worktreeIo.exec(
    `PATH=${shellQuote(pathPrefix)}:$PATH command -v ${shellQuote(binName)} 2>/dev/null`,
    { cwd: '.' },
  );
  const fromPath = which.stdout.trim().split('\n')[0]?.trim();
  if (which.exitCode === 0 && fromPath) return fromPath;
  return null;
}

/**
 * Ensure the engine CLI exists in the guest. Prefers a baked rootfs install;
 * otherwise runs the engine's install command (needs guest network).
 *
 * Installs into {@link GUEST_CLI_HOME} so the binary stays on the PATH
 * {@link finalizeGuestSpawnEnv} builds for chat turns.
 */
export async function ensureGuestEngineCli(
  env: SessionEnv,
  engine: string,
  hostBin: string,
  opts: { guestHome?: string } = {},
): Promise<string> {
  const guestHome = opts.guestHome ?? GUEST_CLI_HOME;
  const spec = GUEST_CLI_INSTALL_BY_ENGINE[engine];
  const binName = spec?.binName ?? path.basename(hostBin);

  const existing = await locateGuestEngineBin(env, binName, guestHome);
  if (existing) return existing;

  if (!spec) {
    throw new Error(
      `No guest install recipe for engine ${engine} (host bin ${hostBin}). ` +
        `Bake the CLI into Dockerfile.guest or extend GUEST_CLI_INSTALL_BY_ENGINE.`,
    );
  }

  const started = Date.now();
  console.log(`[guest-cli] installing ${engine} in guest via: ${spec.installCommand}`);
  // Force user-local install into the staged CLI HOME. Without this, curl
  // installers land under /home/runner/.local while chat spawns with
  // HOME=GUEST_CLI_HOME — and the next turn cannot see the binary.
  const installScript = [
    `export HOME=${shellQuote(guestHome)}`,
    'export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'mkdir -p "$HOME/.local/bin"',
    spec.installCommand,
  ].join(' && ');
  const install = await env.worktreeIo.exec(installScript, {
    cwd: '.',
    timeoutMs: 10 * 60_000,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install ${engine} CLI in guest (exit ${String(install.exitCode)}): ` +
        `${install.stderr.trim() || install.stdout.trim() || '(no output)'}`,
    );
  }

  const found = await locateGuestEngineBin(env, binName, guestHome);
  if (!found) {
    throw new Error(
      `Installed ${engine} in guest but ${binName} is still not on PATH. ` +
        `stderr: ${install.stderr.trim() || '(empty)'}`,
    );
  }
  console.log(`[guest-cli] ${engine} ready at ${found} (install ${Date.now() - started}ms)`);
  return found;
}

/**
 * Stage a minimal CLI HOME outside the git worktree and sync small auth
 * caches from the host per-user HOME when present. API keys already ride in
 * the spawn env; this covers OAuth/device-auth files CLIs still read from disk.
 */
export async function stageGuestCliHome(
  env: SessionEnv,
  hostHome: string | undefined,
): Promise<string> {
  await mkdirAbsGuest(env, GUEST_CLI_HOME);

  if (!hostHome) return GUEST_CLI_HOME;

  const smallFiles = [
    ['.claude.json', '.claude.json'],
    ['.codex/auth.json', '.codex/auth.json'],
    ['.codex/config.toml', '.codex/config.toml'],
    // Cursor browser/`agent login` caches. argv.json alone is not enough —
    // without these the guest CLI reports "Authentication required… run
    // agent login / set CURSOR_API_KEY" even when Account settings shows
    // logged-in (that probe runs on the Hub host against per-user HOME).
    ['.cursor/argv.json', '.cursor/argv.json'],
    ['.cursor/auth.json', '.cursor/auth.json'],
    ['.cursor/cli-config.json', '.cursor/cli-config.json'],
    ['.config/cursor/auth.json', '.config/cursor/auth.json'],
    ['.gemini/settings.json', '.gemini/settings.json'],
  ] as const;

  for (const [hostRel, guestRelTail] of smallFiles) {
    const hostPath = path.join(hostHome, hostRel);
    try {
      const st = await stat(hostPath);
      if (!st.isFile() || st.size > 2_000_000) continue;
      const guestAbs = path.posix.join(GUEST_CLI_HOME, guestRelTail);
      await mkdirAbsGuest(env, path.posix.dirname(guestAbs));
      await writeAbsGuestFile(env, guestAbs, await readFile(hostPath));
    } catch {
      /* missing on host — fine */
    }
  }

  // Claude project/session cache can be large; sync only credentials.json if present.
  try {
    const cred = path.join(hostHome, '.claude', '.credentials.json');
    const st = await stat(cred);
    if (st.isFile() && st.size <= 2_000_000) {
      const guestAbs = path.posix.join(GUEST_CLI_HOME, '.claude', '.credentials.json');
      await mkdirAbsGuest(env, path.posix.dirname(guestAbs));
      await writeAbsGuestFile(env, guestAbs, await readFile(cred));
    }
  } catch {
    /* optional */
  }

  return GUEST_CLI_HOME;
}

/**
 * Copy bundled default-skills outside the worktree so skill wrappers resolve
 * on PATH inside the VM without polluting `git status`.
 */
export async function stageGuestBundledSkills(env: SessionEnv): Promise<{
  guestSkillsRoot: string;
  skillScriptDirs: string[];
}> {
  const marker = path.posix.join(GUEST_SKILLS_ROOT, '.staged');
  const defaultSkillsDir = resolveDefaultSkillsDir();
  if (!(await absExistsInGuest(env, marker))) {
    const tar = spawnSync('tar', ['-C', defaultSkillsDir, '-czf', '-', '.'], {
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (tar.status !== 0 || !tar.stdout) {
      throw new Error(
        `Failed to archive default-skills for guest staging: ${
          tar.stderr?.toString() || `exit ${String(tar.status)}`
        }`,
      );
    }
    const archiveAbs = `${GUEST_SKILLS_ROOT}.tar.gz`;
    await mkdirAbsGuest(env, GUEST_SKILLS_ROOT);
    await writeAbsGuestFile(env, archiveAbs, tar.stdout);
    const extract = await env.worktreeIo.exec(
      `tar -xzf ${shellQuote(archiveAbs)} -C ${shellQuote(GUEST_SKILLS_ROOT)} && ` +
        `rm -f ${shellQuote(archiveAbs)} && touch ${shellQuote(marker)}`,
      { cwd: '.', timeoutMs: 120_000 },
    );
    if (extract.exitCode !== 0) {
      throw new Error(
        `Failed to extract bundled skills in guest: ${
          extract.stderr.trim() || extract.stdout.trim() || '(no output)'
        }`,
      );
    }
  }

  const skillScriptDirs: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(defaultSkillsDir);
  } catch {
    return { guestSkillsRoot: GUEST_SKILLS_ROOT, skillScriptDirs };
  }
  const agentFirst = ['agent-hub', ...entries.filter((n) => n !== 'agent-hub').sort()];
  for (const name of agentFirst) {
    const hostScripts = path.join(defaultSkillsDir, name, 'scripts');
    try {
      const st = await stat(hostScripts);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    skillScriptDirs.push(path.posix.join(GUEST_SKILLS_ROOT, name, 'scripts'));
  }
  return { guestSkillsRoot: GUEST_SKILLS_ROOT, skillScriptDirs };
}

/**
 * Stage the same git/gh Finalize guard shims the host installs via PATH so a
 * Firecracker agent cannot bypass one-session-one-branch / direct-ship gates.
 */
export async function stageGuestSpawnGuards(env: SessionEnv): Promise<string> {
  const marker = path.posix.join(GUEST_SPAWN_GUARDS_DIR, '.staged');
  if (await absExistsInGuest(env, marker)) return GUEST_SPAWN_GUARDS_DIR;

  await mkdirAbsGuest(env, GUEST_SPAWN_GUARDS_DIR);
  for (const name of ['git', 'gh', '_finalize-ship-gate.sh']) {
    const hostPath = path.join(HOST_SPAWN_GUARDS_DIR, name);
    const buf = await readFile(hostPath);
    const guestAbs = path.posix.join(GUEST_SPAWN_GUARDS_DIR, name);
    // Pass mode through write-file so root vm-agent chmod's before the runner
    // user would need to — a post-write chmod as runner fails on root-owned files.
    const mode = name.endsWith('.sh') ? '0644' : '0755';
    await writeAbsGuestFile(env, guestAbs, buf, { mode });
    if (!name.endsWith('.sh')) {
      const check = await env.worktreeIo.exec(`test -x ${shellQuote(guestAbs)}`, { cwd: '.' });
      if (check.exitCode !== 0) {
        throw new Error(
          `Guest spawn guard ${guestAbs} is not executable after staging ` +
            `(chmod/mode handoff failed). stderr: ${check.stderr.trim() || '(empty)'}`,
        );
      }
    }
  }
  const touch = await env.worktreeIo.exec(`touch ${shellQuote(marker)}`, { cwd: '.' });
  if (touch.exitCode !== 0) {
    throw new Error(
      `Failed to write spawn-guards staging marker: ${touch.stderr.trim() || touch.stdout.trim()}`,
    );
  }
  return GUEST_SPAWN_GUARDS_DIR;
}

/**
 * Assert the guest worktree has no untracked Hub runtime pollution under
 * `/workspace/.agent-hub` (defense in depth if an older path leaks back).
 */
export async function assertGuestWorktreeCleanOfRuntime(env: SessionEnv): Promise<void> {
  const probe = await env.worktreeIo.exec(
    `git -C ${shellQuote(FIRECRACKER_GUEST_WORKSPACE)} status --porcelain --untracked-files=all -- .agent-hub 2>/dev/null || true`,
    { cwd: '.' },
  );
  const dirty = probe.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `Guest runtime leaked into the git worktree (.agent-hub):\n${dirty.slice(0, 20).join('\n')}`,
    );
  }
}

export async function prepareGuestCliTurn(opts: {
  env: SessionEnv;
  engine: string;
  hostBin: string;
  hostHome?: string;
}): Promise<{
  guestBin: string;
  guestHome: string;
  guestSkillsRoot: string;
  skillScriptDirs: string[];
  spawnGuardsDir: string;
}> {
  const [guestHome, skills, spawnGuardsDir] = await Promise.all([
    stageGuestCliHome(opts.env, opts.hostHome),
    stageGuestBundledSkills(opts.env),
    stageGuestSpawnGuards(opts.env),
  ]);
  const guestBin = await ensureGuestEngineCli(opts.env, opts.engine, opts.hostBin, {
    guestHome,
  });
  await assertGuestWorktreeCleanOfRuntime(opts.env);
  return {
    guestBin,
    guestHome,
    guestSkillsRoot: skills.guestSkillsRoot,
    skillScriptDirs: skills.skillScriptDirs,
    spawnGuardsDir,
  };
}

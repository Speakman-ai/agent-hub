/**
 * Guest-side agent CLI spawn helpers for env-owned SessionEnv backends
 * (Firecracker).
 *
 * Host `child_process.spawn` against `session.worktree_path` would write a
 * second, divergent tree. Chat turns must run inside the env via
 * {@link SessionEnv.spawn}, with Linux CLIs available in the guest (baked into
 * the rootfs and/or installed on first use) and host-absolute paths remapped.
 */

import { spawnSync } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
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

const GUEST_CLI_HOME_REL = '.agent-hub/cli-home';
const GUEST_SKILLS_REL = '.agent-hub/bundled-skills';
const GUEST_PROMPTS_REL = '.agent-hub/prompts';

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
      !value.startsWith(FIRECRACKER_GUEST_WORKSPACE)
    ) {
      continue;
    }
    out[key] = value;
  }

  out.HOME = opts.guestHome;
  out.AGENT_HUB_SKILLS_DIR = path.posix.join(opts.guestSkillsRoot, 'agent-hub');
  return out;
}

/**
 * Same as {@link adaptSpawnEnvForGuest} but with concrete skill script PATH
 * entries discovered after staging.
 */
export function finalizeGuestSpawnEnv(
  base: Record<string, string>,
  skillScriptDirs: string[],
  guestHome: string,
): Record<string, string> {
  const localBin = `${guestHome}/.local/bin`;
  const pathParts = [
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
  const rel = `${GUEST_PROMPTS_REL}/${sessionId.slice(0, 8)}-${Date.now()}-system-prompt.md`;
  await env.worktreeIo.writeFile(rel, enrichedPrompt);
  const guestPath = path.posix.join(FIRECRACKER_GUEST_WORKSPACE, rel);
  return {
    guestPath,
    cleanup: async () => {
      try {
        await env.worktreeIo.exec(`rm -f ${shellQuote(rel)}`, { cwd: '.' });
      } catch {
        /* best-effort */
      }
    },
  };
}

async function pathExistsInGuest(env: SessionEnv, relOrCommand: string): Promise<boolean> {
  if (relOrCommand.includes('/')) {
    return env.worktreeIo.exists(relOrCommand);
  }
  const result = await env.worktreeIo.exec(
    `command -v ${shellQuote(relOrCommand)} >/dev/null 2>&1`,
    {
      cwd: '.',
    },
  );
  return result.exitCode === 0;
}

/**
 * Ensure the engine CLI exists in the guest. Prefers a baked rootfs install;
 * otherwise runs the engine's install command (needs guest network).
 */
export async function ensureGuestEngineCli(
  env: SessionEnv,
  engine: string,
  hostBin: string,
): Promise<string> {
  const spec = GUEST_CLI_INSTALL_BY_ENGINE[engine];
  const binName = spec?.binName ?? path.basename(hostBin);

  if (await pathExistsInGuest(env, binName)) {
    const located = await env.worktreeIo.exec(`command -v ${shellQuote(binName)}`, { cwd: '.' });
    const found = located.stdout.trim().split('\n')[0]?.trim();
    if (found) return found;
  }

  if (!spec) {
    throw new Error(
      `No guest install recipe for engine ${engine} (host bin ${hostBin}). ` +
        `Bake the CLI into Dockerfile.guest or extend GUEST_CLI_INSTALL_BY_ENGINE.`,
    );
  }

  console.log(`[guest-cli] installing ${engine} in guest via: ${spec.installCommand}`);
  const install = await env.worktreeIo.exec(spec.installCommand, {
    cwd: '.',
    timeoutMs: 10 * 60_000,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install ${engine} CLI in guest (exit ${String(install.exitCode)}): ` +
        `${install.stderr.trim() || install.stdout.trim() || '(no output)'}`,
    );
  }

  const located = await env.worktreeIo.exec(`command -v ${shellQuote(binName)}`, { cwd: '.' });
  const found = located.stdout.trim().split('\n')[0]?.trim();
  if (!found) {
    // Cursor/grok land in ~/.local/bin; ensure that is searchable.
    const homeLocal = await env.worktreeIo.exec(
      `test -x "$HOME/.local/bin/${binName}" && echo "$HOME/.local/bin/${binName}"`,
      { cwd: '.' },
    );
    const alt = homeLocal.stdout.trim();
    if (alt) return alt;
    throw new Error(
      `Installed ${engine} in guest but ${binName} is still not on PATH. ` +
        `stderr: ${install.stderr.trim() || '(empty)'}`,
    );
  }
  return found;
}

async function copyHostFileToGuest(
  env: SessionEnv,
  hostPath: string,
  guestRel: string,
): Promise<void> {
  const buf = await readFile(hostPath);
  await env.worktreeIo.writeFile(guestRel, buf);
}

/**
 * Stage a minimal CLI HOME under the guest worktree and sync small auth
 * caches from the host per-user HOME when present. API keys already ride in
 * the spawn env; this covers OAuth/device-auth files CLIs still read from disk.
 */
export async function stageGuestCliHome(
  env: SessionEnv,
  hostHome: string | undefined,
): Promise<string> {
  await env.worktreeIo.exec(`mkdir -p ${shellQuote(GUEST_CLI_HOME_REL)}`, { cwd: '.' });
  const guestHome = path.posix.join(FIRECRACKER_GUEST_WORKSPACE, GUEST_CLI_HOME_REL);

  if (!hostHome) return guestHome;

  const smallFiles = [
    ['.claude.json', '.claude.json'],
    ['.codex/auth.json', '.codex/auth.json'],
    ['.codex/config.toml', '.codex/config.toml'],
    ['.cursor/argv.json', '.cursor/argv.json'],
    ['.gemini/settings.json', '.gemini/settings.json'],
  ] as const;

  for (const [hostRel, guestRelTail] of smallFiles) {
    const hostPath = path.join(hostHome, hostRel);
    try {
      const st = await stat(hostPath);
      if (!st.isFile() || st.size > 2_000_000) continue;
      const guestRel = path.posix.join(GUEST_CLI_HOME_REL, guestRelTail);
      await env.worktreeIo.exec(`mkdir -p ${shellQuote(path.posix.dirname(guestRel))}`, {
        cwd: '.',
      });
      await copyHostFileToGuest(env, hostPath, guestRel);
    } catch {
      /* missing on host — fine */
    }
  }

  // Claude project/session cache can be large; sync only credentials.json if present.
  try {
    const cred = path.join(hostHome, '.claude', '.credentials.json');
    const st = await stat(cred);
    if (st.isFile() && st.size <= 2_000_000) {
      const guestRel = path.posix.join(GUEST_CLI_HOME_REL, '.claude', '.credentials.json');
      await env.worktreeIo.exec(`mkdir -p ${shellQuote(path.posix.dirname(guestRel))}`, {
        cwd: '.',
      });
      await copyHostFileToGuest(env, cred, guestRel);
    }
  } catch {
    /* optional */
  }

  return guestHome;
}

/**
 * Copy bundled default-skills into the guest worktree so skill wrappers resolve
 * on PATH inside the VM.
 */
export async function stageGuestBundledSkills(env: SessionEnv): Promise<{
  guestSkillsRoot: string;
  skillScriptDirs: string[];
}> {
  const marker = path.posix.join(GUEST_SKILLS_REL, '.staged');
  const defaultSkillsDir = resolveDefaultSkillsDir();
  if (!(await env.worktreeIo.exists(marker))) {
    // Tar on the host, write one archive into the guest, extract there.
    // Skills tree is ~1MB — under the vsock write-file frame cap.
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
    const archiveRel = `${GUEST_SKILLS_REL}.tar.gz`;
    await env.worktreeIo.exec(`mkdir -p ${shellQuote(GUEST_SKILLS_REL)}`, { cwd: '.' });
    await env.worktreeIo.writeFile(archiveRel, tar.stdout);
    const extract = await env.worktreeIo.exec(
      `tar -xzf ${shellQuote(archiveRel)} -C ${shellQuote(GUEST_SKILLS_REL)} && ` +
        `rm -f ${shellQuote(archiveRel)} && touch ${shellQuote(marker)}`,
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

  const guestSkillsRoot = path.posix.join(FIRECRACKER_GUEST_WORKSPACE, GUEST_SKILLS_REL);
  const skillScriptDirs: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(defaultSkillsDir);
  } catch {
    return { guestSkillsRoot, skillScriptDirs };
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
    skillScriptDirs.push(path.posix.join(guestSkillsRoot, name, 'scripts'));
  }
  return { guestSkillsRoot, skillScriptDirs };
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
}> {
  const [guestHome, skills] = await Promise.all([
    stageGuestCliHome(opts.env, opts.hostHome),
    stageGuestBundledSkills(opts.env),
  ]);
  const guestBin = await ensureGuestEngineCli(opts.env, opts.engine, opts.hostBin);
  return {
    guestBin,
    guestHome,
    guestSkillsRoot: skills.guestSkillsRoot,
    skillScriptDirs: skills.skillScriptDirs,
  };
}

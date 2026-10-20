/**
 * Lifecycle for the organization acceptance server. The spec owns the process (rather than a
 * Playwright webServer) so it can stop and start the Hub mid-flow and prove that startup
 * repair leaves archived agents archived.
 *
 * The server gets an allowlisted environment, never the caller's: a developer or CI shell can
 * carry cloud, fleet and artifact settings that would make a test server reach real
 * infrastructure. Agent CLIs point at fake-agent-cli.sh.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, '..', '..', 'server');
const FAKE_CLI = path.join(here, 'fake-agent-cli.sh');

export const SERVER_PORT = Number(process.env.E2E_ORG_SERVER_PORT) || 4061;
export const API_BASE = `http://localhost:${SERVER_PORT}`;

/** PATH without session spawn guards, which wrap git and hang outside a Hub session. */
function cleanPath(): string {
  return (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')
    .split(path.delimiter)
    .filter(
      (entry) => entry && !entry.includes('spawn-guards') && !entry.includes('default-skills'),
    )
    .join(path.delimiter);
}

function serverEnv(root: string): Record<string, string> {
  const home = path.join(root, 'home');
  return {
    PATH: cleanPath(),
    LANG: process.env.LANG || 'C.UTF-8',
    TMPDIR: os.tmpdir(),
    HOME: home,
    NODE_ENV: 'development',
    AGENT_HUB_PORT: String(SERVER_PORT),
    AGENT_HUB_DATA_DIR: path.join(root, 'data'),
    AGENT_HUB_PROJECTS_DIR: path.join(home, 'projects'),
    CLAUDE_BIN: FAKE_CLI,
    CURSOR_BIN: FAKE_CLI,
    CODEX_BIN: FAKE_CLI,
    GEMINI_BIN: FAKE_CLI,
    GROK_BIN: FAKE_CLI,
    AGENT_HUB_PROVISIONING_STUB: '1',
    AGENT_HUB_DISABLE_INITIAL_BUILD: '1',
    AGENT_HUB_DISABLE_PUSH_CI: '1',
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const reachable = () =>
  fetch(`${API_BASE}/api/auth/status`).then(
    (res) => res.ok,
    () => false,
  );

/**
 * One harness instance owns one private temporary root (data dir, HOME, project checkouts,
 * server log). It is created once and survives restart(), so the restarted Hub reads the same
 * state, and it never touches another run's root. Two concurrent runs still need different
 * ports; a busy port fails start() before anything is written.
 */
export class HubServer {
  private child: ChildProcess | null = null;
  private dir: string | null = null;

  /** Created on first use, not at import: Playwright also imports specs just to list tests. */
  get root(): string {
    this.dir ??= mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-organizations-'));
    return this.dir;
  }

  get log(): string {
    return path.join(this.root, 'server.log');
  }

  /** Fresh data, HOME and one git checkout per project id, inside this instance's root. */
  prepare(projectIds: string[]): Record<string, string> {
    const env = serverEnv(this.root);
    mkdirSync(env.AGENT_HUB_DATA_DIR, { recursive: true });
    mkdirSync(env.AGENT_HUB_PROJECTS_DIR, { recursive: true });
    writeFileSync(path.join(env.AGENT_HUB_DATA_DIR, 'projects.json'), '[]');
    const cwds: Record<string, string> = {};
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    for (const id of projectIds) {
      const cwd = path.join(this.root, 'repos', id);
      mkdirSync(cwd, { recursive: true });
      writeFileSync(path.join(cwd, 'README.md'), `# ${id}\n`);
      git(cwd, 'init', '-q', '-b', 'main');
      git(cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@e2e.test', 'add', '.');
      git(cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@e2e.test', 'commit', '-qm', 'init');
      cwds[id] = cwd;
    }
    return cwds;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (await reachable())
      throw new Error(`Port ${SERVER_PORT} is already serving; stop the other server first`);
    const log = openSync(this.log, 'a');
    // detached → own process group, so stop() also reaps the tsx child.
    this.child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
      cwd: SERVER_DIR,
      env: serverEnv(this.root),
      stdio: ['ignore', log, log],
      detached: true,
    });
    await waitUntil(reachable, 90_000, `the Hub to accept requests (log: ${this.log})`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.child = null;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 15_000);
    await exited;
    clearTimeout(timer);
    await waitUntil(async () => !(await reachable()), 15_000, 'the Hub to stop');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop the Hub and delete this instance's root. Set E2E_ORG_KEEP=1 to keep it for debugging. */
  async dispose(): Promise<void> {
    await this.stop();
    if (this.dir && !process.env.E2E_ORG_KEEP) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}

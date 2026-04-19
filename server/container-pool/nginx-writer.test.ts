/**
 * nginx-writer tests (W2).
 *
 * Critical contract: **reload idempotency**. The writer must skip the
 * `systemctl reload` entirely when the config file + symlink are already
 * correct — `pull_request.synchronize` fires on every push and bouncing
 * nginx every time is both noisy and a quality-of-service hit for
 * unrelated preview envs.
 */

import { describe, it, expect } from 'vitest';
import {
  writePreviewConf,
  removePreviewConf,
  reloadNginx,
  type NginxFsOps,
  type NginxRunner,
  type NginxWriterDeps,
} from './nginx-writer.js';

// ─── fakes ────────────────────────────────────────────────────────────────

interface FakeFsState {
  files: Map<string, string>;
  links: Map<string, string>;
  mkdirs: string[];
  removed: string[];
}

function makeFakeFs(): NginxFsOps & { state: FakeFsState } {
  const state: FakeFsState = {
    files: new Map(),
    links: new Map(),
    mkdirs: [],
    removed: [],
  };
  return {
    state,
    async readFile(p) {
      return state.files.has(p) ? (state.files.get(p) as string) : null;
    },
    async writeFile(p, contents) {
      state.files.set(p, contents);
    },
    async mkdir(p) {
      state.mkdirs.push(p);
    },
    async symlinkIfAbsent(target, link) {
      if (!state.links.has(link)) state.links.set(link, target);
    },
    async rm(p) {
      state.removed.push(p);
      state.files.delete(p);
      state.links.delete(p);
    },
    async readlink(p) {
      return state.links.get(p) ?? null;
    },
  };
}

interface FakeRunnerState {
  calls: Array<{ command: string; args: readonly string[] }>;
  failOn: Map<string, { code: number; stderr: string }>;
}

function makeFakeRunner(): NginxRunner & { state: FakeRunnerState } {
  const state: FakeRunnerState = { calls: [], failOn: new Map() };
  return {
    state,
    async run(command, args) {
      state.calls.push({ command, args });
      const key = `${command} ${args.join(' ')}`;
      const failure = state.failOn.get(key);
      if (failure) return { code: failure.code, stderr: failure.stderr };
      return { code: 0, stderr: '' };
    },
  };
}

function freshDeps(): NginxWriterDeps & {
  fs: ReturnType<typeof makeFakeFs>;
  runner: ReturnType<typeof makeFakeRunner>;
} {
  const fs = makeFakeFs();
  const runner = makeFakeRunner();
  return {
    fs,
    runner,
    sitesAvailableDir: '/etc/nginx/sites-available',
    sitesEnabledDir: '/etc/nginx/sites-enabled',
  };
}

// ─── suite ────────────────────────────────────────────────────────────────

describe('writePreviewConf — first install', () => {
  it('writes the conf, creates a symlink, runs nginx -t, and reloads', async () => {
    const deps = freshDeps();
    const result = await writePreviewConf(deps, {
      filename: 'pr-1.preview.conf',
      body: 'server { listen 443; }\n',
    });

    expect(result.reloaded).toBe(true);
    expect(result.confPath).toBe('/etc/nginx/sites-available/pr-1.preview.conf');
    expect(result.symlinkPath).toBe('/etc/nginx/sites-enabled/pr-1.preview.conf');

    expect(deps.fs.state.files.get(result.confPath)).toBe('server { listen 443; }\n');
    expect(deps.fs.state.links.get(result.symlinkPath)).toBe(result.confPath);

    // nginx -t then systemctl reload.
    expect(deps.runner.state.calls).toEqual([
      { command: 'nginx', args: ['-t'] },
      { command: 'systemctl', args: ['reload', 'nginx'] },
    ]);
  });
});

describe('writePreviewConf — idempotency (the critical contract)', () => {
  it('calling twice with identical input results in exactly one reload', async () => {
    const deps = freshDeps();
    const body = 'server { listen 443; }\n';

    const first = await writePreviewConf(deps, { filename: 'pr-2.preview.conf', body });
    expect(first.reloaded).toBe(true);

    const second = await writePreviewConf(deps, { filename: 'pr-2.preview.conf', body });
    expect(second.reloaded).toBe(false);

    const reloadCalls = deps.runner.state.calls.filter(
      (c) => c.command === 'systemctl' && c.args[0] === 'reload',
    );
    expect(reloadCalls).toHaveLength(1);
  });

  it('a body change triggers a fresh write + reload', async () => {
    const deps = freshDeps();
    await writePreviewConf(deps, { filename: 'pr-3.preview.conf', body: 'v1' });
    const out = await writePreviewConf(deps, { filename: 'pr-3.preview.conf', body: 'v2' });
    expect(out.reloaded).toBe(true);
    expect(deps.fs.state.files.get(out.confPath)).toBe('v2');
  });
});

describe('writePreviewConf — failure modes', () => {
  it('nginx -t failure aborts before reload', async () => {
    const deps = freshDeps();
    deps.runner.state.failOn.set('nginx -t', { code: 1, stderr: 'syntax error in line 4' });

    await expect(
      writePreviewConf(deps, { filename: 'pr-4.preview.conf', body: 'bad' }),
    ).rejects.toThrow(/nginx -t failed/);

    // File was written but reload was NOT attempted.
    expect(deps.fs.state.files.size).toBeGreaterThan(0);
    const reloads = deps.runner.state.calls.filter((c) => c.command === 'systemctl');
    expect(reloads).toHaveLength(0);
  });

  it('systemctl reload failure is surfaced as an error', async () => {
    const deps = freshDeps();
    deps.runner.state.failOn.set('systemctl reload nginx', {
      code: 1,
      stderr: 'nginx.service: main process exited',
    });

    await expect(
      writePreviewConf(deps, { filename: 'pr-5.preview.conf', body: 'x' }),
    ).rejects.toThrow(/systemctl reload nginx failed/);
  });
});

describe('removePreviewConf', () => {
  it('removes symlink + conf file idempotently', async () => {
    const deps = freshDeps();
    await writePreviewConf(deps, { filename: 'pr-6.preview.conf', body: 'x' });
    await removePreviewConf(deps, { filename: 'pr-6.preview.conf' });

    expect(deps.fs.state.removed).toContain('/etc/nginx/sites-enabled/pr-6.preview.conf');
    expect(deps.fs.state.removed).toContain('/etc/nginx/sites-available/pr-6.preview.conf');
  });

  it('is safe to call when files are already missing', async () => {
    const deps = freshDeps();
    // No setup — just remove.
    await expect(
      removePreviewConf(deps, { filename: 'pr-7.preview.conf' }),
    ).resolves.toBeUndefined();
  });
});

describe('reloadNginx', () => {
  it('runs nginx -t then systemctl reload', async () => {
    const deps = freshDeps();
    await reloadNginx(deps);
    expect(deps.runner.state.calls).toEqual([
      { command: 'nginx', args: ['-t'] },
      { command: 'systemctl', args: ['reload', 'nginx'] },
    ]);
  });
});

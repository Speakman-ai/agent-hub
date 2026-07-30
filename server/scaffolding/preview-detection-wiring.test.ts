/**
 * Wiring tests for the provisioning-route preview-detection subscriber.
 *
 * These exercise `subscribePreviewDetection` against a real orchestrator
 * job + a real workspace tree on disk. The provisioning happy path is
 * covered separately in `test/provisioning-route.test.ts`; this file
 * isolates the detection-and-mutate behaviour so a regression there
 * fails loudly without dragging in the full Express stack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';

import {
  _resetJobsForTests,
  startProvisioningJob,
  subscribeToJob,
  type ProvisioningExecutor,
} from '../provisioning/orchestrator.js';
import { subscribePreviewDetection } from '../routes/provisioning.js';
import { validatePrEnvProjectConfig } from '../routes/projects.js';
import type { Project } from '../types.js';

function writePkg(dir: string, contents: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(contents, null, 2));
}

interface FakeJobOptions {
  workspaceDir: string;
  /**
   * Simulate the executor's behaviour for `copy-template`. Defaults to
   * 'ok' — pass 'failed' to confirm detection does NOT fire on a failed
   * copy.
   */
  copyStatus?: 'ok' | 'failed';
}

function makeExecutor(opts: FakeJobOptions): ProvisioningExecutor {
  return {
    async runPhase(phase) {
      if (phase === 'copy-template') {
        if (opts.copyStatus === 'failed') {
          return {
            status: 'failed',
            error: { code: -1, message: 'copy blew up' },
          };
        }
        return { status: 'ok', message: 'copied' };
      }
      return { status: 'ok' };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out waiting for predicate');
}

describe('subscribePreviewDetection', () => {
  let tmpRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    _resetJobsForTests();
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'preview-wiring-'));
    workspaceDir = path.join(tmpRoot, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('applies vite defaults to project.prEnv.devServer after copy-template ok', async () => {
    writePkg(workspaceDir, { devDependencies: { vite: '^5.0.0' } });

    const project: Project = {
      id: 'proj-1',
      name: 'Proj 1',
      cwd: tmpRoot,
      ahw: tmpRoot,
      mode: 'dev',
      agents: [],
    };
    const broadcasts: Array<Record<string, unknown>> = [];
    let saved = 0;

    const jobId = 'wiring-vite';
    const executor = makeExecutor({ workspaceDir });

    startProvisioningJob({
      jobId,
      payload: { description: 'x' },
      projectId: 'proj-1',
      executor,
    });

    subscribePreviewDetection({
      jobId,
      projectId: 'proj-1',
      workspaceDir,
      project,
      saveProjects: () => {
        saved++;
      },
      broadcast: (msg) => {
        broadcasts.push(msg);
      },
    });

    await waitFor(() => !!project.prEnv?.devServer);

    expect(project.prEnv?.devServer).toEqual({
      startCommand: 'npm run dev',
      portMap: [{ internalPort: 5173, label: 'web', primary: true }],
      captureRoutes: ['/'],
      idleTTL: 600,
      env: {},
      secretKeys: [],
      aptPackages: [],
    });
    expect(project.prEnv?.startScript).toBe('npm run dev');
    expect(project.prEnv?.internalPort).toBe(5173);
    // The persisted shape must pass the cross-field validator so that
    // subsequent PATCH calls don't 400.
    const validation = validatePrEnvProjectConfig(project.prEnv);
    expect(validation.ok).toBe(true);
    expect(saved).toBe(1);

    const detectMsg = broadcasts.find((b) => b.type === 'preview-defaults-detected');
    expect(detectMsg).toMatchObject({
      type: 'preview-defaults-detected',
      projectId: 'proj-1',
      jobId,
      detected: { stack: 'vite', port: 5173 },
    });
  });

  it('broadcasts a null detection when the workspace stack is unknown', async () => {
    writePkg(workspaceDir, { dependencies: { lodash: '^4.0.0' } });

    const project: Project = {
      id: 'proj-2',
      name: 'Proj 2',
      cwd: tmpRoot,
      ahw: tmpRoot,
      mode: 'dev',
      agents: [],
    };
    const broadcasts: Array<Record<string, unknown>> = [];
    let saved = 0;

    const jobId = 'wiring-unknown';
    startProvisioningJob({
      jobId,
      payload: { description: 'x' },
      projectId: 'proj-2',
      executor: makeExecutor({ workspaceDir }),
    });

    subscribePreviewDetection({
      jobId,
      projectId: 'proj-2',
      workspaceDir,
      project,
      saveProjects: () => {
        saved++;
      },
      broadcast: (msg) => {
        broadcasts.push(msg);
      },
    });

    await waitFor(() => broadcasts.some((b) => b.type === 'preview-defaults-detected'));

    expect(project.prEnv?.devServer).toBeUndefined();
    expect(saved).toBe(0);
    const msg = broadcasts.find((b) => b.type === 'preview-defaults-detected');
    expect(msg).toMatchObject({ detected: null });
  });

  it('does not mutate the project when copy-template fails', async () => {
    writePkg(workspaceDir, { devDependencies: { vite: '^5.0.0' } });

    const project: Project = {
      id: 'proj-3',
      name: 'Proj 3',
      cwd: tmpRoot,
      ahw: tmpRoot,
      mode: 'dev',
      agents: [],
    };
    const broadcasts: Array<Record<string, unknown>> = [];

    const jobId = 'wiring-failed';
    startProvisioningJob({
      jobId,
      payload: { description: 'x' },
      projectId: 'proj-3',
      executor: makeExecutor({ workspaceDir, copyStatus: 'failed' }),
    });

    subscribePreviewDetection({
      jobId,
      projectId: 'proj-3',
      workspaceDir,
      project,
      saveProjects: () => {},
      broadcast: (msg) => {
        broadcasts.push(msg);
      },
    });

    // Wait for the orchestrator to emit its terminal 'done' event — that
    // is the positive signal that the failed copy-template phase ran and
    // the job halted. Asserting absence of a side effect before this
    // point would race against the orchestrator (the predicate starts
    // true on tick 0, before any phase has dispatched).
    let jobDone = false;
    subscribeToJob(jobId, (ev) => {
      if (ev.type === 'done') jobDone = true;
    });
    await waitFor(() => jobDone, 500);

    expect(project.prEnv).toBeUndefined();
    expect(broadcasts.find((b) => b.type === 'preview-defaults-detected')).toBeUndefined();
  });
});

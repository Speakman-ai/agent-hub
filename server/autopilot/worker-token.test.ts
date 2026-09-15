import '../test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  AutopilotWorkerCredentialError,
  autopilotSessionBindingPath,
  bindAutopilotWorkerSession,
  readAutopilotSessionBinding,
  readAutopilotWorkerToken,
  removeAutopilotWorkerToken,
  resolveAutopilotWorkerSpawn,
  unbindAutopilotWorkerSession,
  writeAutopilotWorkerToken,
} from './worker-token.js';

describe('autopilot worker token files', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'autopilot-worker-token-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a worker token and session binding for spawn lookup', () => {
    writeAutopilotWorkerToken('run-1', 'ahub_scoped_worker', dataDir);
    expect(readAutopilotWorkerToken('run-1', dataDir)).toBe('ahub_scoped_worker');
    bindAutopilotWorkerSession('sess-1', { projectId: 'demo-app', runId: 'run-1' }, dataDir);
    expect(readAutopilotSessionBinding('sess-1', dataDir)).toEqual({
      projectId: 'demo-app',
      runId: 'run-1',
      role: 'implementer',
      origin: null,
      operationId: null,
      deploymentId: null,
      expectedSha: null,
    });
    expect(resolveAutopilotWorkerSpawn('sess-1', dataDir)).toEqual({
      token: 'ahub_scoped_worker',
      projectId: 'demo-app',
      runId: 'run-1',
      role: 'implementer',
    });
  });

  it('resolves the evaluator token, not the implementer token', () => {
    writeAutopilotWorkerToken('run-1', 'ahub_implementer', dataDir);
    writeAutopilotWorkerToken('run-1', 'ahub_evaluator', dataDir, 'evaluator');
    bindAutopilotWorkerSession(
      'sess-eval',
      {
        projectId: 'demo-app',
        runId: 'run-1',
        role: 'evaluator',
        origin: 'http://127.0.0.1:4310',
      },
      dataDir,
    );
    expect(readAutopilotSessionBinding('sess-eval', dataDir)).toEqual({
      projectId: 'demo-app',
      runId: 'run-1',
      role: 'evaluator',
      origin: 'http://127.0.0.1:4310',
      operationId: null,
      deploymentId: null,
      expectedSha: null,
    });
    expect(resolveAutopilotWorkerSpawn('sess-eval', dataDir)).toEqual({
      token: 'ahub_evaluator',
      projectId: 'demo-app',
      runId: 'run-1',
      role: 'evaluator',
    });
  });

  it('writes token files with mode 0600', () => {
    const filePath = writeAutopilotWorkerToken('run-1', 'ahub_token', dataDir);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('returns null for unbound sessions and throws when a bound token is missing', () => {
    expect(resolveAutopilotWorkerSpawn('sess-missing', dataDir)).toBeNull();
    bindAutopilotWorkerSession('sess-1', { projectId: 'demo-app', runId: 'run-1' }, dataDir);
    expect(() => resolveAutopilotWorkerSpawn('sess-1', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    writeAutopilotWorkerToken('run-1', 'ahub_scoped', dataDir);
    expect(resolveAutopilotWorkerSpawn('sess-1', dataDir)?.token).toBe('ahub_scoped');
    removeAutopilotWorkerToken('run-1', dataDir);
    expect(() => resolveAutopilotWorkerSpawn('sess-1', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    unbindAutopilotWorkerSession('sess-1', dataDir);
    expect(readAutopilotSessionBinding('sess-1', dataDir)).toBeNull();
    expect(resolveAutopilotWorkerSpawn('sess-1', dataDir)).toBeNull();
  });

  it('rejects unsafe ids', () => {
    expect(() => writeAutopilotWorkerToken('../etc', 'tok', dataDir)).toThrow(/invalid runId/);
    expect(() =>
      bindAutopilotWorkerSession('../sess', { projectId: 'p', runId: 'r' }, dataDir),
    ).toThrow(/invalid sessionId/);
  });

  it('throws on empty, malformed, or incomplete binding files instead of treating them as unbound', () => {
    const filePath = autopilotSessionBindingPath('sess-broken', dataDir);
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

    writeFileSync(filePath, '');
    expect(() => readAutopilotSessionBinding('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    expect(() => resolveAutopilotWorkerSpawn('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );

    writeFileSync(filePath, '{ not json');
    expect(() => readAutopilotSessionBinding('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    expect(() => resolveAutopilotWorkerSpawn('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );

    writeFileSync(filePath, JSON.stringify({ projectId: 'demo-app' }));
    expect(() => readAutopilotSessionBinding('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    expect(() => resolveAutopilotWorkerSpawn('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );

    writeFileSync(filePath, JSON.stringify({ runId: 'run-1' }));
    expect(() => readAutopilotSessionBinding('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );
    expect(() => resolveAutopilotWorkerSpawn('sess-broken', dataDir)).toThrow(
      AutopilotWorkerCredentialError,
    );

    expect(readAutopilotSessionBinding('sess-absent', dataDir)).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  describeWorktreeComposePaths,
  missingWorktreeComposePaths,
  parseComposeBuildContexts,
  waitForWorktreeComposeReady,
} from './worktree-compose-ready.js';

describe('parseComposeBuildContexts', () => {
  it('extracts relative build contexts', () => {
    const yaml = `services:
  backend:
    build:
      context: ./backend
  frontend:
    build:
      context: "./frontend"
`;
    expect(parseComposeBuildContexts(yaml)).toEqual(['backend', 'frontend']);
  });
});

describe('missingWorktreeComposePaths', () => {
  it('checks build.context under composeFileDir, not an unreachable host path', () => {
    const containerDir = mkdtempSync(path.join(tmpdir(), 'wt-container-'));
    const hostDir = mkdtempSync(path.join(tmpdir(), 'wt-host-'));
    const yaml = 'services:\n  web:\n    build:\n      context: ./backend\n';
    writeFileSync(path.join(containerDir, 'compose.preview.yml'), yaml);
    writeFileSync(path.join(hostDir, 'compose.preview.yml'), yaml);
    mkdirSync(path.join(containerDir, 'backend'));
    expect(
      missingWorktreeComposePaths(hostDir, 'compose.preview.yml', {
        composeFileDir: containerDir,
        buildContextDir: hostDir,
      }),
    ).toEqual([]);
    expect(
      missingWorktreeComposePaths(hostDir, 'compose.preview.yml', {
        buildContextDir: hostDir,
      }),
    ).toEqual(['backend']);
  });
});

describe('describeWorktreeComposePaths', () => {
  it('reports the exact paths the Hub process checks', () => {
    expect(
      describeWorktreeComposePaths('/host/wt', 'compose.preview.yml', {
        composeFileDir: '/container/wt',
        buildContextDir: '/host/wt',
      }),
    ).toEqual({
      composePath: '/container/wt/compose.preview.yml',
      composeRoot: '/container/wt',
      buildRoot: '/host/wt',
      worktreeDir: '/host/wt',
    });
  });
});

describe('waitForWorktreeComposeReady', () => {
  it('resolves when paths appear during polling', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wt-ready-'));
    writeFileSync(
      path.join(dir, 'compose.preview.yml'),
      'services:\n  web:\n    build:\n      context: ./backend\n',
    );
    const sleep = vi.fn().mockImplementation(async () => {
      mkdirSync(path.join(dir, 'backend'));
    });
    await waitForWorktreeComposeReady({
      worktreeDir: dir,
      composeFile: 'compose.preview.yml',
      timeoutMs: 5000,
      pollIntervalMs: 10,
      sleep,
    });
    expect(missingWorktreeComposePaths(dir, 'compose.preview.yml')).toEqual([]);
  });

  it('throws when paths never appear', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wt-miss-'));
    writeFileSync(
      path.join(dir, 'compose.preview.yml'),
      'services:\n  web:\n    build:\n      context: ./backend\n',
    );
    await expect(
      waitForWorktreeComposeReady({
        worktreeDir: dir,
        composeFile: 'compose.preview.yml',
        timeoutMs: 30,
        pollIntervalMs: 10,
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      /missing: backend\. Checked compose file at .*compose\.preview\.yml; build contexts under .*wt-miss-/,
    );
  });

  it('names the checked compose path when the compose file is not visible', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wt-no-compose-'));
    await expect(
      waitForWorktreeComposeReady({
        worktreeDir: dir,
        composeFile: 'compose.preview.yml',
        timeoutMs: 30,
        pollIntervalMs: 10,
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      /missing: compose\.preview\.yml\. Checked compose file at .*compose\.preview\.yml/,
    );
  });
});

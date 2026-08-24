import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { registerCursorRuleFile, sweepOrphanedCursorRuleFiles } from './cursor-rule-registry.js';

describe('cursor-rule-registry', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.AGENT_HUB_DATA_DIR;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'cursor-rule-reg-'));
    process.env.AGENT_HUB_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.AGENT_HUB_DATA_DIR;
    else process.env.AGENT_HUB_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function ruleFile(dir: string, sid: string): string {
    const p = path.join(dir, '.cursor', 'rules', `agent-hub.session-${sid}.mdc`);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '---\nalwaysApply: true\n---\nrules\n', 'utf8');
    return p;
  }

  it('sweeps registered files a crashed process left behind, then clears the manifest', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'crashed-repo-'));
    try {
      const leaked = ruleFile(repo, 'sessX');
      registerCursorRuleFile(leaked);
      expect(existsSync(leaked)).toBe(true);

      const removed = sweepOrphanedCursorRuleFiles();
      expect(removed).toBe(1);
      expect(existsSync(leaked)).toBe(false);

      // Manifest is cleared, so a second sweep is a no-op.
      expect(sweepOrphanedCursorRuleFiles()).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op when the file was already removed by the close handler', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'clean-repo-'));
    try {
      const p = ruleFile(repo, 'sessY');
      registerCursorRuleFile(p);
      rmSync(p, { force: true }); // simulate the close handler having cleaned up
      expect(sweepOrphanedCursorRuleFiles()).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('dedupes repeated registrations of the same path', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'dup-repo-'));
    try {
      const p = ruleFile(repo, 'sessZ');
      registerCursorRuleFile(p);
      registerCursorRuleFile(p);
      registerCursorRuleFile(p);
      expect(sweepOrphanedCursorRuleFiles()).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('only ever touches managed agent-hub.session-*.mdc files', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-repo-'));
    try {
      // A non-managed path smuggled into the manifest must be ignored.
      const foreign = path.join(repo, '.cursor', 'rules', 'user-rule.mdc');
      mkdirSync(path.dirname(foreign), { recursive: true });
      writeFileSync(foreign, 'user rule\n', 'utf8');
      const mp = path.join(dataDir, 'cursor-session-rules.log');
      writeFileSync(mp, `${foreign}\n`, 'utf8');

      expect(sweepOrphanedCursorRuleFiles()).toBe(0);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never follows a symlink target when unlinking', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'symlink-repo-'));
    try {
      const target = path.join(repo, 'secret.txt');
      writeFileSync(target, 'keep me\n', 'utf8');
      const link = path.join(repo, '.cursor', 'rules', 'agent-hub.session-evil.mdc');
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link);
      registerCursorRuleFile(link);

      sweepOrphanedCursorRuleFiles();
      // The link is removed; the target it pointed at is untouched.
      expect(existsSync(link)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('keep me\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('retains an entry (not truncated) when the file still exists but deletion fails', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'retain-repo-'));
    try {
      // A directory at a managed-name path: it still "exists", but rmSync
      // without `recursive` throws — the same shape as a transient perm/fs
      // error where the file cannot be removed. It must NOT be dropped.
      const stuck = path.join(repo, '.cursor', 'rules', 'agent-hub.session-stuck.mdc');
      mkdirSync(stuck, { recursive: true });
      registerCursorRuleFile(stuck);

      expect(sweepOrphanedCursorRuleFiles()).toBe(0);
      // The file is still present AND its cleanup record survived, so the next
      // sweep will retry it rather than leaving it to contaminate forever.
      expect(existsSync(stuck)).toBe(true);
      const mp = path.join(dataDir, 'cursor-session-rules.log');
      expect(readFileSync(mp, 'utf8')).toContain(stuck);

      // Once the blocker clears (dir replaced by a plain file), the retained
      // entry is retried by the next sweep, which removes it and clears the
      // record — no re-registration needed, the retention carried the path.
      rmSync(stuck, { recursive: true, force: true });
      writeFileSync(stuck, 'rules\n', 'utf8');
      expect(sweepOrphanedCursorRuleFiles()).toBe(1);
      expect(existsSync(stuck)).toBe(false);
      expect(readFileSync(mp, 'utf8')).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

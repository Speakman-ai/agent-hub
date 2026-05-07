import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import {
  trackChild,
  killProcessGroup,
  killAllTrackedProcessGroups,
  _resetProcessGroupsForTesting,
  _trackedChildCountForTesting,
} from './process-groups.js';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  _resetProcessGroupsForTesting();
});

describe('process-groups', () => {
  describe('killProcessGroup', () => {
    it('terminates the entire subtree when child was spawned detached', async () => {
      // bash spawns a sleep grandchild, prints its PID to stdout, then waits.
      // Killing the process group should kill both bash and the sleep grandchild.
      const proc = spawn(
        'bash',
        ['-c', 'sleep 30 & SLEEP_PID=$!; echo $SLEEP_PID; wait $SLEEP_PID'],
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(proc.pid).toBeGreaterThan(0);

      // Read the grandchild PID from stdout.
      let stdoutBuf = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
      });

      // Give the grandchild a moment to start and emit its PID.
      await wait(150);
      const grandchildPid = parseInt(stdoutBuf.trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isAlive(grandchildPid)).toBe(true);

      killProcessGroup(proc, 'SIGTERM');

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.once('exit', (code) => resolve(code));
      });
      // bash terminated by SIGTERM → exit code null (signaled).
      expect(exitCode).toBeNull();
      expect(isAlive(proc.pid!)).toBe(false);
      // Grandchild must also be dead — this is the regression we care about.
      await wait(50);
      expect(isAlive(grandchildPid)).toBe(false);
    });

    it('falls back to direct kill when child was not detached', async () => {
      const proc = spawn('bash', ['-c', 'sleep 30'], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(proc.pid).toBeGreaterThan(0);
      await wait(50);

      // -pid lookup will fail (no process group with that id); helper falls back.
      killProcessGroup(proc, 'SIGTERM');

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.once('exit', (code) => resolve(code));
      });
      expect(exitCode).toBeNull();
    });

    it('is a no-op for a null/dead proc', () => {
      expect(() => killProcessGroup(null)).not.toThrow();
      expect(() => killProcessGroup(undefined)).not.toThrow();
      expect(() => killProcessGroup({ pid: undefined })).not.toThrow();
      expect(() => killProcessGroup({ pid: null })).not.toThrow();
    });
  });

  describe('trackChild + killAllTrackedProcessGroups', () => {
    it('tracks children and removes them on close', async () => {
      const proc = spawn('bash', ['-c', 'exit 0'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      trackChild(proc);
      expect(_trackedChildCountForTesting()).toBe(1);

      await new Promise<void>((resolve) => proc.once('close', () => resolve()));
      // Allow the cleanup listener to fire.
      await wait(20);
      expect(_trackedChildCountForTesting()).toBe(0);
    });

    it('SIGTERMs every tracked group and SIGKILLs survivors after grace', async () => {
      // One that ignores SIGTERM (traps it), to force the SIGKILL escalation.
      const stubborn = spawn('bash', ['-c', 'trap "" TERM; sleep 30'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // One that exits cleanly on SIGTERM.
      const cooperative = spawn('bash', ['-c', 'sleep 30'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      trackChild(stubborn);
      trackChild(cooperative);
      await wait(80);

      const stubbornPid = stubborn.pid!;
      const cooperativePid = cooperative.pid!;

      const stubbornExit = new Promise<number | null>((resolve) =>
        stubborn.once('exit', (code) => resolve(code)),
      );
      const cooperativeExit = new Promise<number | null>((resolve) =>
        cooperative.once('exit', (code) => resolve(code)),
      );

      // Short grace so the test runs fast.
      const drain = killAllTrackedProcessGroups(200);
      await Promise.all([drain, stubbornExit, cooperativeExit]);

      expect(isAlive(stubbornPid)).toBe(false);
      expect(isAlive(cooperativePid)).toBe(false);
    });
  });
});

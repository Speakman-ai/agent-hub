/**
 * Reusable SessionEnv contract suite — behavior every adapter must honor,
 * expressed only through the `SessionEnv` interface plus a small harness.
 *
 * The host adapter runs it today (`host-session-env.test.ts`); the sysbox
 * adapter must import and pass the same suite when it ships. Import only
 * from `*.test.ts` files — this module pulls in vitest globals.
 */

import { describe, expect, it } from 'vitest';
import { SessionEnv, SessionEnvDisposedError } from './session-env.js';

export interface SessionEnvContractHarness {
  /** Fresh env wired to fully-faked IO (never real processes). */
  createEnv(): Promise<SessionEnv> | SessionEnv;
  /** Make the process behind `handlePid` exit with `code`. */
  exitProcess(env: SessionEnv, pid: number, code: number): void;
  /** Advance the fake clock past any dispose grace window. */
  advanceClock(ms: number): Promise<void>;
}

export function describeSessionEnvContract(
  adapterName: string,
  harness: SessionEnvContractHarness,
): void {
  describe(`SessionEnv contract: ${adapterName}`, () => {
    it('exposes kind, sessionId and creation/activity timestamps', async () => {
      const env = await harness.createEnv();
      expect(['host', 'sysbox']).toContain(env.kind);
      expect(env.sessionId.length).toBeGreaterThan(0);
      expect(env.disposed).toBe(false);
      expect(env.lastActivityAtMs).toBeGreaterThanOrEqual(env.createdAtMs);
    });

    it('spawn returns a live process; exit fires hooks and drops the live count', async () => {
      const env = await harness.createEnv();
      const proc = env.spawn('echo hi');
      expect(proc.pid).not.toBeNull();
      expect(proc.exited).toBe(false);
      expect(env.liveProcessCount()).toBe(1);

      const exits: Array<{ code: number | null }> = [];
      proc.onExit((r) => exits.push(r));
      harness.exitProcess(env, proc.pid!, 0);

      expect(proc.exited).toBe(true);
      expect(proc.exitResult).toEqual({ code: 0, signal: null });
      expect(exits).toEqual([{ code: 0, signal: null }]);
      expect(env.liveProcessCount()).toBe(0);
    });

    it('onExit on an already-exited process fires immediately', async () => {
      const env = await harness.createEnv();
      const proc = env.spawn('true');
      harness.exitProcess(env, proc.pid!, 3);
      let fired: number | null = null;
      proc.onExit((r) => {
        fired = r.code;
      });
      expect(fired).toBe(3);
    });

    it('mapPort is idempotent per internal port and reflected in listPortMappings', async () => {
      const env = await harness.createEnv();
      const a = await env.mapPort(5173);
      const b = await env.mapPort(5173);
      expect(b).toEqual(a);
      expect(a.internalPort).toBe(5173);
      expect(a.hostUrl).toBe(`http://127.0.0.1:${a.hostPort}`);
      const listed = env.listPortMappings();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(a);
    });

    it('mapPortsOut resolves ports loopback-only and shares mapPort caching', async () => {
      // 5173 is the single port every adapter harness declares up front —
      // sysbox publishes are fixed at container start, so the contract can
      // only exercise a pre-declared port. Multi-port ordering is covered in
      // the host adapter's own suite.
      const env = await harness.createEnv();
      const [a] = await env.mapPortsOut([5173]);
      expect(a.internalPort).toBe(5173);
      expect(a.hostUrl).toBe(`http://127.0.0.1:${a.hostPort}`);
      // Idempotent: a prior mapPort mapping is returned, not re-allocated.
      const direct = await env.mapPort(5173);
      expect(direct).toEqual(a);
      const again = await env.mapPortsOut([5173]);
      expect(again).toEqual([a]);
      // No-arg form mirrors listPortMappings.
      expect(await env.mapPortsOut()).toEqual(env.listPortMappings());
    });

    it('mountWorktree reports an in-env path and a host path only when shared', async () => {
      const env = await harness.createEnv();
      const mount = await env.mountWorktree();
      expect(mount.envPath.length).toBeGreaterThan(0);
      expect(mount.sharing).toBe(env.worktreeSharing);
      // A host path must be offered exactly when it is authoritative.
      // Advertising one under env-owned sharing is how stale reads start.
      if (mount.sharing === 'host-shared') {
        expect(mount.hostPath?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(mount.hostPath).toBeNull();
      }
    });

    it('worktreeIo agrees with the env about how the worktree is shared', async () => {
      const env = await harness.createEnv();
      expect(env.worktreeIo.sharing).toBe(env.worktreeSharing);
      expect(env.worktreeIo.hostPath === null).toBe(env.worktreeSharing === 'env-owned');
    });

    it('touch bumps lastActivityAtMs', async () => {
      const env = await harness.createEnv();
      const before = env.lastActivityAtMs;
      await harness.advanceClock(1000);
      env.touch();
      expect(env.lastActivityAtMs).toBeGreaterThan(before);
    });

    it('dispose is idempotent, fires onDispose hooks once, then rejects all ops', async () => {
      const env = await harness.createEnv();
      let hookRuns = 0;
      env.onDispose(() => {
        hookRuns += 1;
      });

      const first = env.dispose({ graceMs: 10 });
      const second = env.dispose({ graceMs: 10 });
      await Promise.all([first, second]);
      expect(env.disposed).toBe(true);
      expect(hookRuns).toBe(1);

      // Wrap in a resolved chain so both sync throws and async rejections pass.
      expect(() => env.spawn('echo nope')).toThrow(SessionEnvDisposedError);
      await expect(Promise.resolve().then(() => env.openPty())).rejects.toThrow(
        SessionEnvDisposedError,
      );
      await expect(Promise.resolve().then(() => env.mapPort(3000))).rejects.toThrow(
        SessionEnvDisposedError,
      );
      await expect(Promise.resolve().then(() => env.mountWorktree())).rejects.toThrow(
        SessionEnvDisposedError,
      );
    });

    it('a spawn-less env disposes cleanly with no live work', async () => {
      const env = await harness.createEnv();
      expect(env.liveProcessCount()).toBe(0);
      await env.dispose({ graceMs: 10 });
      expect(env.listPortMappings()).toEqual([]);
    });
  });
}

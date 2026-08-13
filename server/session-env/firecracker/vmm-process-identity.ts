/**
 * Durable VMM process identity — PID alone is reused by the kernel after exit,
 * so a stale `vmm.pid` must not authorize SIGKILL of an unrelated process.
 */
import { readFileSync, realpathSync } from 'fs';
import type { VmmProcessIdentity } from './firecracker-session-env.js';

/** Result of inspecting `/proc/<pid>` for a recorded VMM. */
export type ProcessIdentityLookup =
  | { status: 'live'; identity: VmmProcessIdentity }
  | { status: 'missing' }
  | { status: 'unreadable'; reason: string };

/**
 * Read live process identity from `/proc`.
 *
 * `missing` means the PID is gone (`ENOENT`). Any other failure (hidepid,
 * `EACCES`, parse errors while the process may still exist) is `unreadable` —
 * callers must fail closed rather than treating that as "already exited".
 */
export function readLiveProcessIdentity(pid: number): ProcessIdentityLookup {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `/proc/<pid>/stat`: `pid (comm) state … starttime …` — comm may contain
    // spaces/parens, so split after the final `)`.
    const close = stat.lastIndexOf(')');
    if (close < 0) {
      return { status: 'unreadable', reason: `malformed /proc/${pid}/stat` };
    }
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    // After `)`, field index 0 is state (overall field 3); starttime is overall 22 → index 19.
    const starttime = fields[19] ?? '';
    if (!starttime) {
      return { status: 'unreadable', reason: `missing starttime in /proc/${pid}/stat` };
    }
    let exe = '';
    try {
      exe = realpathSync(`/proc/${pid}/exe`);
    } catch {
      // exe can vanish mid-exit; cmdline+starttime still uniquely identify.
    }
    return {
      status: 'live',
      identity: {
        pid,
        cmdline: cmdline.toString('binary'),
        starttime,
        exe,
      },
    };
  } catch (err) {
    return classifyProcReadFailure(err);
  }
}

/** Map a `/proc` read failure to missing vs unreadable (fail-closed). */
export function classifyProcReadFailure(
  err: unknown,
): Exclude<ProcessIdentityLookup, { status: 'live' }> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return { status: 'missing' };
  const reason = err instanceof Error ? err.message : String(err);
  return { status: 'unreadable', reason };
}

export function identitiesMatch(expected: VmmProcessIdentity, live: VmmProcessIdentity): boolean {
  if (expected.pid !== live.pid) return false;
  if (expected.starttime !== live.starttime) return false;
  if (expected.cmdline !== live.cmdline) return false;
  // If we recorded an exe, require it to match when the live process still has one.
  if (expected.exe && live.exe && expected.exe !== live.exe) return false;
  return true;
}

export function parseVmmIdentityFile(raw: string): VmmProcessIdentity | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VmmProcessIdentity>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.cmdline !== 'string' ||
      typeof parsed.starttime !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      cmdline: parsed.cmdline,
      starttime: parsed.starttime,
      exe: typeof parsed.exe === 'string' ? parsed.exe : '',
    };
  } catch {
    return null;
  }
}

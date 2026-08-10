/**
 * Durable VMM process identity — PID alone is reused by the kernel after exit,
 * so a stale `vmm.pid` must not authorize SIGKILL of an unrelated process.
 */
import { readFileSync, realpathSync } from 'fs';
import type { VmmProcessIdentity } from './firecracker-session-env.js';

export function readLiveProcessIdentity(pid: number): VmmProcessIdentity | null {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `/proc/<pid>/stat`: `pid (comm) state … starttime …` — comm may contain
    // spaces/parens, so split after the final `)`.
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    // After `)`, field index 0 is state (overall field 3); starttime is overall 22 → index 19.
    const starttime = fields[19] ?? '';
    if (!starttime) return null;
    let exe = '';
    try {
      exe = realpathSync(`/proc/${pid}/exe`);
    } catch {
      // exe can vanish mid-exit; cmdline+starttime still uniquely identify.
    }
    return {
      pid,
      cmdline: cmdline.toString('binary'),
      starttime,
      exe,
    };
  } catch {
    return null;
  }
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

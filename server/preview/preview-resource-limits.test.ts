import './../test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import {
  computePreviewCpuset,
  resolvePreviewLimits,
  buildUpdateArgs,
  applyPreviewResourceLimits,
} from './preview-resource-limits.js';

describe('computePreviewCpuset', () => {
  it('reserves the first N cores for the Hub on an 8-core box', () => {
    expect(computePreviewCpuset(8, 2)).toBe('2-7');
  });
  it('still pins on a 4-core box (2 reserved, 2 for previews)', () => {
    expect(computePreviewCpuset(4, 2)).toBe('2-3');
  });
  it('degrades to no-pinning when there are too few cores to carve out', () => {
    expect(computePreviewCpuset(3, 2)).toBeNull(); // need reserve+2 = 4
    expect(computePreviewCpuset(2, 2)).toBeNull();
    expect(computePreviewCpuset(1, 1)).toBeNull();
  });
  it('returns null for nonsensical input', () => {
    expect(computePreviewCpuset(NaN, 2)).toBeNull();
    expect(computePreviewCpuset(8, 0)).toBeNull();
  });
});

describe('resolvePreviewLimits', () => {
  it('defaults: cpus=2, memory off, cpuset auto from core count', () => {
    const l = resolvePreviewLimits({}, 8);
    expect(l).toEqual({ cpus: 2, memory: null, cpuset: '2-7' });
  });
  it('honors env overrides', () => {
    const l = resolvePreviewLimits(
      {
        AGENT_HUB_PREVIEW_CPU_LIMIT: '1.5',
        AGENT_HUB_PREVIEW_MEM_LIMIT: '4g',
        AGENT_HUB_PREVIEW_CPUSET: '3-7',
      },
      8,
    );
    expect(l).toEqual({ cpus: 1.5, memory: '4g', cpuset: '3-7' });
  });
  it('an explicit reserved-cores count changes the auto cpuset', () => {
    expect(resolvePreviewLimits({ AGENT_HUB_PREVIEW_HOST_RESERVED_CORES: '4' }, 16).cpuset).toBe(
      '4-15',
    );
  });
  it('falls back to cpus=2 on a bad value', () => {
    expect(resolvePreviewLimits({ AGENT_HUB_PREVIEW_CPU_LIMIT: 'nope' }, 8).cpus).toBe(2);
  });
});

describe('buildUpdateArgs', () => {
  it('builds cpus + cpuset (memory omitted)', () => {
    expect(buildUpdateArgs({ cpus: 2, memory: null, cpuset: '2-7' }, 'abc')).toEqual([
      'update',
      '--cpus',
      '2',
      '--cpuset-cpus',
      '2-7',
      'abc',
    ]);
  });
  it('includes memory (and memory-swap) when set', () => {
    expect(buildUpdateArgs({ cpus: 1, memory: '4g', cpuset: null }, 'xyz')).toEqual([
      'update',
      '--cpus',
      '1',
      '--memory',
      '4g',
      '--memory-swap',
      '4g',
      'xyz',
    ]);
  });
});

describe('applyPreviewResourceLimits', () => {
  it('no-ops when disabled via env', async () => {
    const exec = vi.fn();
    const res = await applyPreviewResourceLimits({
      composeProjectName: 'agenthub-session-x',
      env: { AGENT_HUB_DISABLE_PREVIEW_LIMITS: '1' },
      exec,
    });
    expect(res).toEqual({ updated: 0, total: 0 });
    expect(exec).not.toHaveBeenCalled();
  });

  it('updates every container in the compose project', async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'ps') return { stdout: 'c1\nc2\n\n' };
      return { stdout: '' };
    });
    const res = await applyPreviewResourceLimits({
      composeProjectName: 'agenthub-session-abc',
      env: {},
      coreCount: 8,
      exec,
    });
    expect(res).toEqual({ updated: 2, total: 2 });
    // one ps + two updates
    expect(exec).toHaveBeenCalledTimes(3);
    expect(calls[0]).toContain('label=com.docker.compose.project=agenthub-session-abc');
    expect(calls[1]).toEqual(['docker', 'update', '--cpus', '2', '--cpuset-cpus', '2-7', 'c1']);
    expect(calls[2]).toEqual(['docker', 'update', '--cpus', '2', '--cpuset-cpus', '2-7', 'c2']);
  });

  it('is best-effort: a failed update is skipped, never thrown', async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'ps') return { stdout: 'good\nbad\n' };
      if (args.includes('bad')) throw new Error('container gone');
      return { stdout: '' };
    });
    const res = await applyPreviewResourceLimits({
      composeProjectName: 'p',
      env: {},
      coreCount: 8,
      exec,
    });
    expect(res).toEqual({ updated: 1, total: 2 });
  });

  it('returns 0 when docker ps fails (no docker)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('docker: not found');
    });
    const res = await applyPreviewResourceLimits({ composeProjectName: 'p', env: {}, exec });
    expect(res).toEqual({ updated: 0, total: 0 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RESOURCE_PROFILE_NAME,
  RUNNER_RESOURCE_PROFILES,
  buildRunnerResourceArgs,
  hasExplicitResourceProfile,
  parseMemoryToBytes,
  profileNameForVisibility,
  resolveRunnerResourceArgs,
  resolveRunnerResourceProfile,
} from './runner-resource-profile.js';

const GiB = 1024 * 1024 * 1024;

describe('parseMemoryToBytes', () => {
  it('parses bare bytes', () => {
    expect(parseMemoryToBytes('1024')).toBe(1024);
  });

  it('parses docker-style suffixes (binary multiples, case-insensitive)', () => {
    expect(parseMemoryToBytes('16g')).toBe(16 * GiB);
    expect(parseMemoryToBytes('16GB')).toBe(16 * GiB);
    expect(parseMemoryToBytes('512m')).toBe(512 * 1024 * 1024);
    expect(parseMemoryToBytes('2k')).toBe(2 * 1024);
  });

  it('returns null for absent / blank / unparseable input', () => {
    expect(parseMemoryToBytes(undefined)).toBeNull();
    expect(parseMemoryToBytes('')).toBeNull();
    expect(parseMemoryToBytes('   ')).toBeNull();
    expect(parseMemoryToBytes('lots')).toBeNull();
    expect(parseMemoryToBytes('0')).toBeNull();
    expect(parseMemoryToBytes('-4g')).toBeNull();
    expect(parseMemoryToBytes('4tb')).toBeNull();
  });
});

describe('resolveRunnerResourceProfile', () => {
  it('defaults to the stricter ubuntu-private tier (never faster than GitHub regardless of repo visibility)', () => {
    const p = resolveRunnerResourceProfile({});
    expect(p.name).toBe(DEFAULT_RESOURCE_PROFILE_NAME);
    expect(p.name).toBe('ubuntu-private');
    expect(p.cpus).toBe(2);
    expect(p.memoryBytes).toBe(8 * GiB);
  });

  it('selects a named profile via FINALIZE_RUNNER_RESOURCE_PROFILE', () => {
    const priv = resolveRunnerResourceProfile({
      FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-private',
    });
    expect(priv.cpus).toBe(2);
    expect(priv.memoryBytes).toBe(8 * GiB);

    const slim = resolveRunnerResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-slim' });
    expect(slim.cpus).toBe(1);
    expect(slim.memoryBytes).toBe(5 * GiB);
  });

  it('profile name is case-insensitive and trimmed', () => {
    const p = resolveRunnerResourceProfile({
      FINALIZE_RUNNER_RESOURCE_PROFILE: '  UBUNTU-PRIVATE  ',
    });
    expect(p.name).toBe('ubuntu-private');
  });

  it('falls back to the default on an unknown profile name (a typo must not silently uncap)', () => {
    const p = resolveRunnerResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-enormous' });
    expect(p.name).toBe('ubuntu-private');
    expect(p.cpus).toBe(2);
  });

  it('honours the unconstrained escape hatch', () => {
    const p = resolveRunnerResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: 'unconstrained' });
    expect(p.cpus).toBeNull();
    expect(p.memoryBytes).toBeNull();
  });

  it('granular overrides layer on top of the base profile', () => {
    const p = resolveRunnerResourceProfile({
      FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-private',
      FINALIZE_RUNNER_CPUS: '3',
      FINALIZE_RUNNER_MEMORY: '12g',
    });
    expect(p.cpus).toBe(3);
    expect(p.memoryBytes).toBe(12 * GiB);
    expect(p.name).toBe('ubuntu-private');
  });

  it('allows a single override (the other dimension keeps the profile value)', () => {
    const p = resolveRunnerResourceProfile({ FINALIZE_RUNNER_CPUS: '3' });
    expect(p.cpus).toBe(3);
    expect(p.memoryBytes).toBe(8 * GiB); // ubuntu-private default RAM
  });

  it('can cap an otherwise-unconstrained profile via overrides', () => {
    const p = resolveRunnerResourceProfile({
      FINALIZE_RUNNER_RESOURCE_PROFILE: 'unconstrained',
      FINALIZE_RUNNER_CPUS: '2',
    });
    expect(p.cpus).toBe(2);
    expect(p.memoryBytes).toBeNull();
  });

  it('ignores invalid override values and keeps the base profile', () => {
    const p = resolveRunnerResourceProfile({
      FINALIZE_RUNNER_CPUS: 'fast',
      FINALIZE_RUNNER_MEMORY: 'plenty',
    });
    expect(p.cpus).toBe(2);
    expect(p.memoryBytes).toBe(8 * GiB);
  });
});

describe('profileNameForVisibility', () => {
  it('maps public -> ubuntu-public (exact GitHub parity, 4 vCPU / 16 GB)', () => {
    expect(profileNameForVisibility('public')).toBe('ubuntu-public');
  });

  it('maps private -> ubuntu-private (exact GitHub parity, 2 vCPU / 8 GB)', () => {
    expect(profileNameForVisibility('private')).toBe('ubuntu-private');
  });

  it('maps unknown / undefined -> the stricter default (never the beefier tier)', () => {
    expect(profileNameForVisibility('unknown')).toBe(DEFAULT_RESOURCE_PROFILE_NAME);
    expect(profileNameForVisibility(undefined)).toBe(DEFAULT_RESOURCE_PROFILE_NAME);
    expect(DEFAULT_RESOURCE_PROFILE_NAME).toBe('ubuntu-private');
  });
});

describe('hasExplicitResourceProfile', () => {
  it('is true for a valid pinned profile', () => {
    expect(hasExplicitResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-public' })).toBe(
      true,
    );
    expect(hasExplicitResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: '  UBUNTU-SLIM ' })).toBe(
      true,
    );
  });

  it('is false when unset, blank, or a typo (a typo is not an explicit override)', () => {
    expect(hasExplicitResourceProfile({})).toBe(false);
    expect(hasExplicitResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: '' })).toBe(false);
    expect(
      hasExplicitResourceProfile({ FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-enormous' }),
    ).toBe(false);
  });
});

describe('resolveRunnerResourceProfile — repo visibility', () => {
  it('derives ubuntu-public from a public repo when no env override is set', () => {
    const p = resolveRunnerResourceProfile({}, { visibility: 'public' });
    expect(p.name).toBe('ubuntu-public');
    expect(p.cpus).toBe(4);
    expect(p.memoryBytes).toBe(16 * GiB);
  });

  it('derives ubuntu-private from a private repo (exact parity)', () => {
    const p = resolveRunnerResourceProfile({}, { visibility: 'private' });
    expect(p.name).toBe('ubuntu-private');
    expect(p.cpus).toBe(2);
    expect(p.memoryBytes).toBe(8 * GiB);
  });

  it('keeps the stricter default for unknown visibility (detection miss can never run faster than GitHub)', () => {
    const p = resolveRunnerResourceProfile({}, { visibility: 'unknown' });
    expect(p.name).toBe('ubuntu-private');
    expect(p.cpus).toBe(2);
  });

  it('an explicit valid env profile WINS over a derived visibility', () => {
    // public repo would derive ubuntu-public, but the operator pinned slim.
    const p = resolveRunnerResourceProfile(
      { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-slim' },
      { visibility: 'public' },
    );
    expect(p.name).toBe('ubuntu-slim');
    expect(p.cpus).toBe(1);
  });

  it('a typo env profile is ignored; visibility still selects the accurate (parity) tier', () => {
    // A typo is not an explicit override, so it falls through to visibility.
    // ubuntu-public is still EXACT parity for a public repo — not an uncap.
    const p = resolveRunnerResourceProfile(
      { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-enormous' },
      { visibility: 'public' },
    );
    expect(p.name).toBe('ubuntu-public');
    expect(p.cpus).toBe(4);
  });

  it('a typo env profile with unknown visibility still falls to the stricter default', () => {
    const p = resolveRunnerResourceProfile(
      { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-enormous' },
      { visibility: 'unknown' },
    );
    expect(p.name).toBe('ubuntu-private');
    expect(p.cpus).toBe(2);
  });

  it('granular overrides still layer on top of a visibility-derived profile', () => {
    const p = resolveRunnerResourceProfile({ FINALIZE_RUNNER_CPUS: '3' }, { visibility: 'public' });
    expect(p.name).toBe('ubuntu-public');
    expect(p.cpus).toBe(3); // override
    expect(p.memoryBytes).toBe(16 * GiB); // ubuntu-public RAM kept
  });

  it('resolveRunnerResourceArgs threads visibility through to docker flags', () => {
    expect(resolveRunnerResourceArgs({}, { visibility: 'public' })).toEqual([
      '--cpus',
      '4',
      '--memory',
      String(16 * GiB),
      '--memory-swap',
      String(16 * GiB),
    ]);
  });
});

describe('resolveRunnerResourceProfile — forceProfile (non-gate work, e.g. deploys)', () => {
  it('forceProfile=unconstrained wins over env override AND visibility, with no caps', () => {
    const p = resolveRunnerResourceProfile(
      { FINALIZE_RUNNER_RESOURCE_PROFILE: 'ubuntu-slim', FINALIZE_RUNNER_CPUS: '2' },
      { visibility: 'private', forceProfile: 'unconstrained' },
    );
    expect(p.name).toBe('unconstrained');
    expect(p.cpus).toBeNull();
    expect(p.memoryBytes).toBeNull();
  });

  it('forceProfile=unconstrained emits no docker resource flags', () => {
    expect(
      resolveRunnerResourceArgs({ FINALIZE_RUNNER_CPUS: '8' }, { forceProfile: 'unconstrained' }),
    ).toEqual([]);
  });
});

describe('buildRunnerResourceArgs', () => {
  it('emits --cpus and a HARD memory cap (--memory == --memory-swap, no swap headroom)', () => {
    const args = buildRunnerResourceArgs(RUNNER_RESOURCE_PROFILES['ubuntu-private']);
    expect(args).toEqual([
      '--cpus',
      '2',
      '--memory',
      String(8 * GiB),
      '--memory-swap',
      String(8 * GiB),
    ]);
  });

  it('emits no flags for an unconstrained profile', () => {
    expect(buildRunnerResourceArgs(RUNNER_RESOURCE_PROFILES['unconstrained'])).toEqual([]);
  });

  it('emits only the capped dimension when one is uncapped', () => {
    expect(buildRunnerResourceArgs({ name: 'unconstrained', cpus: 2, memoryBytes: null })).toEqual([
      '--cpus',
      '2',
    ]);
  });
});

describe('resolveRunnerResourceArgs', () => {
  it('resolves env to docker flags in one call (default profile)', () => {
    expect(resolveRunnerResourceArgs({})).toEqual([
      '--cpus',
      '2',
      '--memory',
      String(8 * GiB),
      '--memory-swap',
      String(8 * GiB),
    ]);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveRunsOnImage,
  isContainerRunsOn,
  isMacosRunsOn,
  macosRunnerMismatch,
  runnerClassForRunsOn,
  MACOS_RUNNER_CLASS,
  DEFAULT_RUNNER_CLASS,
  DEFAULT_UBUNTU_24_04_IMAGE,
} from './runner-images.js';

describe('resolveRunsOnImage', () => {
  afterEach(() => {
    delete process.env.FINALIZE_RUNNER_IMAGE_UBUNTU_24_04;
  });

  it('returns null for host', () => {
    expect(resolveRunsOnImage('host')).toBeNull();
    expect(isContainerRunsOn('host')).toBe(false);
  });

  it('maps ubuntu-24.04 to the default runner image', () => {
    expect(resolveRunsOnImage('ubuntu-24.04')).toBe(DEFAULT_UBUNTU_24_04_IMAGE);
    expect(isContainerRunsOn('ubuntu-24.04')).toBe(true);
  });

  it('respects FINALIZE_RUNNER_IMAGE_UBUNTU_24_04 override', () => {
    process.env.FINALIZE_RUNNER_IMAGE_UBUNTU_24_04 = 'my-registry/runner:custom';
    expect(resolveRunsOnImage('ubuntu-24.04')).toBe('my-registry/runner:custom');
  });

  it('passes through explicit image refs', () => {
    expect(resolveRunsOnImage('ghcr.io/org/custom-runner:v1')).toBe('ghcr.io/org/custom-runner:v1');
  });

  it('treats the whole macOS label family as native host (no container image)', () => {
    // Every macOS variant — bare, versioned, sized, arch'd, latest — must resolve
    // to the native-host path, never a container image.
    for (const label of [
      'macos',
      'macos-latest',
      'macos-14',
      'MacOS-14',
      ' macos-15 ',
      'macos-15-large',
      'macos-15-xlarge',
      'macos-26-xlarge',
      'macos-14-arm64',
      'macos-latest-large',
    ]) {
      expect(resolveRunsOnImage(label)).toBeNull();
      expect(isContainerRunsOn(label)).toBe(false);
    }
  });

  it('still passes through an image ref that happens to start with "macos-"', () => {
    // A fully-qualified image ref is not a macOS runner label — the image-ref
    // pass-through must win so the container path is preserved.
    expect(resolveRunsOnImage('ghcr.io/org/macos-tools:v1')).toBe('ghcr.io/org/macos-tools:v1');
    expect(isContainerRunsOn('ghcr.io/org/macos-tools:v1')).toBe(true);
  });
});

describe('isMacosRunsOn', () => {
  it('recognises the macOS runner label family, including sized/arch/future variants', () => {
    for (const label of [
      'macos',
      'macos-latest',
      'macos-13',
      'macos-14',
      'macos-15',
      'macos-26',
      'macos-15-large',
      'macos-15-xlarge',
      'macos-26-xlarge',
      'macos-14-arm64',
      'macos-latest-xlarge',
      'macos-99', // a not-yet-released version must still be recognised
      'MACOS-15', // case-insensitive
      '  macos-13  ', // whitespace-insensitive
    ]) {
      expect(isMacosRunsOn(label)).toBe(true);
    }
  });

  it('is false for non-macOS labels and image refs', () => {
    for (const label of [
      'ubuntu-24.04',
      'ubuntu-latest',
      'host',
      'windows-latest',
      'mac',
      'macosx', // not the macos family (no separating dash)
      'macos-', // dangling dash is not a real variant
      'ghcr.io/org/macos-tools:v1', // image ref, not a runner label
      '',
    ]) {
      expect(isMacosRunsOn(label)).toBe(false);
    }
  });
});

describe('runnerClassForRunsOn', () => {
  it('routes macOS labels to the macos class and everything else to default', () => {
    for (const label of ['macos', 'macos-14', 'macos-15-xlarge', 'MACOS-latest']) {
      expect(runnerClassForRunsOn(label)).toBe(MACOS_RUNNER_CLASS);
    }
    for (const label of ['ubuntu-24.04', 'ubuntu-latest', 'host', 'macosx', '']) {
      expect(runnerClassForRunsOn(label)).toBe(DEFAULT_RUNNER_CLASS);
    }
  });
});

describe('macosRunnerMismatch', () => {
  it('returns null when the backend advertises a darwin native host (job may proceed)', () => {
    // A Mac Hub (local backend on darwin) or a macOS-capable fleet.
    expect(macosRunnerMismatch('macos-14', 'local', ['darwin'])).toBeNull();
    expect(macosRunnerMismatch('macos', 'local', ['darwin'])).toBeNull();
    expect(macosRunnerMismatch('macos-15-xlarge', 'remote', ['linux', 'darwin'])).toBeNull();
  });

  it('returns a reason when a LOCAL (Linux Hub) backend cannot provide macOS', () => {
    const reason = macosRunnerMismatch('macos-14', 'local', ['linux']);
    expect(reason).toBeTruthy();
    expect(reason).toContain('macos-14');
    expect(reason).toContain('local');
    expect(reason).toContain('linux');
  });

  it('returns a reason for a REMOTE backend with no macOS capacity, without blaming the coordinator', () => {
    // The reviewer's case: a Linux Hub with a remote fleet must be rejected by
    // BACKEND capability (the fleet has no macOS host), not by process.platform.
    const reason = macosRunnerMismatch('macos-14', 'remote', []);
    expect(reason).toBeTruthy();
    expect(reason).toContain('remote');
    expect(reason).toContain('none'); // no native platforms advertised
  });

  it('guards sized/arch/future macOS variants against an incapable backend (regression)', () => {
    // Regression for the round-2 hole: sized/xlarge/arch variants were dropped by
    // the old exact-match set, so they took the native-host path UNGUARDED and
    // ran macOS steps on Linux. Each must now be guarded when no macOS host exists.
    for (const label of [
      'macos-15-large',
      'macos-15-xlarge',
      'macos-26-xlarge',
      'macos-14-arm64',
      'macos-latest-large',
    ]) {
      const reason = macosRunnerMismatch(label, 'local', ['linux']);
      expect(reason, `${label} must be guarded on a non-macOS backend`).toBeTruthy();
      expect(reason).toContain(label);
    }
  });

  it('returns null for non-macOS labels regardless of backend capability', () => {
    expect(macosRunnerMismatch('ubuntu-24.04', 'local', ['linux'])).toBeNull();
    expect(macosRunnerMismatch('host', 'local', ['linux'])).toBeNull();
    expect(macosRunnerMismatch('ubuntu-24.04', 'remote', [])).toBeNull();
  });
});

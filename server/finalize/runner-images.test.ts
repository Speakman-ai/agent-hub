import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveRunsOnImage,
  isContainerRunsOn,
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
});

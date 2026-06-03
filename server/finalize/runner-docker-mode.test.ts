import { afterEach, describe, expect, it } from 'vitest';
import { resolveRunnerDockerMode, isDindRunnerMode } from './runner-docker-mode.js';

describe('runner-docker-mode', () => {
  afterEach(() => {
    delete process.env.FINALIZE_RUNNER_DOCKER_MODE;
  });

  it('defaults to dind', () => {
    expect(resolveRunnerDockerMode()).toBe('dind');
    expect(isDindRunnerMode()).toBe(true);
  });

  it('honors host-socket escape hatch', () => {
    process.env.FINALIZE_RUNNER_DOCKER_MODE = 'host-socket';
    expect(resolveRunnerDockerMode()).toBe('host-socket');
    expect(isDindRunnerMode()).toBe(false);
  });
});

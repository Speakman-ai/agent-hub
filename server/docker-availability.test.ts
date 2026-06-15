import { describe, it, expect } from 'vitest';
import {
  resolveDockerAvailability,
  resolveDockerSocketPath,
  DEFAULT_DOCKER_SOCKET,
  DISABLE_DOCKER_FEATURES_ENV,
} from './docker-availability.js';

const present = () => true;
const absent = () => false;

describe('resolveDockerSocketPath', () => {
  it('defaults to the compiled-in docker socket', () => {
    expect(resolveDockerSocketPath({})).toBe(DEFAULT_DOCKER_SOCKET);
  });

  it('honors a unix:// DOCKER_HOST', () => {
    expect(resolveDockerSocketPath({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toBe(
      '/run/user/1000/docker.sock',
    );
  });

  it('honors FINALIZE_DOCKER_SOCKET when DOCKER_HOST is unset', () => {
    expect(resolveDockerSocketPath({ FINALIZE_DOCKER_SOCKET: '/custom/docker.sock' })).toBe(
      '/custom/docker.sock',
    );
  });

  it('returns null for a non-unix DOCKER_HOST (tcp)', () => {
    expect(resolveDockerSocketPath({ DOCKER_HOST: 'tcp://1.2.3.4:2375' })).toBeNull();
  });
});

describe('resolveDockerAvailability', () => {
  it('disables reapers when the socket is missing (the preview case)', () => {
    const r = resolveDockerAvailability({ env: {}, socketExists: absent });
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain(DEFAULT_DOCKER_SOCKET);
  });

  it('enables reapers when the socket is present', () => {
    const r = resolveDockerAvailability({ env: {}, socketExists: present });
    expect(r.enabled).toBe(true);
  });

  it('explicit disable override wins even when the socket is present', () => {
    const r = resolveDockerAvailability({
      env: { [DISABLE_DOCKER_FEATURES_ENV]: '1' },
      socketExists: present,
    });
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain(DISABLE_DOCKER_FEATURES_ENV);
  });

  it('explicit force-on override wins even when the socket is missing', () => {
    const r = resolveDockerAvailability({
      env: { [DISABLE_DOCKER_FEATURES_ENV]: 'false' },
      socketExists: absent,
    });
    expect(r.enabled).toBe(true);
  });

  it('assumes docker is reachable for a non-unix DOCKER_HOST (cannot probe)', () => {
    const r = resolveDockerAvailability({
      env: { DOCKER_HOST: 'tcp://1.2.3.4:2375' },
      socketExists: absent,
    });
    expect(r.enabled).toBe(true);
  });

  it('accepts common truthy/falsy spellings of the override', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
      expect(
        resolveDockerAvailability({
          env: { [DISABLE_DOCKER_FEATURES_ENV]: v },
          socketExists: present,
        }).enabled,
      ).toBe(false);
    }
    for (const v of ['0', 'false', 'NO', 'off']) {
      expect(
        resolveDockerAvailability({
          env: { [DISABLE_DOCKER_FEATURES_ENV]: v },
          socketExists: absent,
        }).enabled,
      ).toBe(true);
    }
  });
});

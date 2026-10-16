import { describe, expect, it } from 'vitest';
import { createOrgDataGeneration, shouldLoadOrgData } from './orgDataLoad';

describe('shouldLoadOrgData', () => {
  it('waits until the user has signed in', () => {
    expect(shouldLoadOrgData({ configReady: true, needsAuth: true, hasServerUrl: true })).toBe(
      false,
    );
  });

  it('loads once config is ready and the session is authenticated', () => {
    expect(shouldLoadOrgData({ configReady: true, needsAuth: false, hasServerUrl: true })).toBe(
      true,
    );
  });

  it('does not load before a server URL exists', () => {
    expect(shouldLoadOrgData({ configReady: true, needsAuth: false, hasServerUrl: false })).toBe(
      false,
    );
  });
});

describe('createOrgDataGeneration', () => {
  it('discards a load that started before a newer one', () => {
    const generations = createOrgDataGeneration();
    const first = generations.begin();
    const second = generations.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

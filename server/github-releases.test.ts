import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { listUserFacingReleases, resetReleaseCacheForTests } from './github-releases.js';

describe('listUserFacingReleases', () => {
  beforeEach(() => {
    resetReleaseCacheForTests();
    execFileSyncMock.mockReset();
  });

  it('throws a clear error when GitHub fetch fails and local tags are unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      }),
    );

    execFileSyncMock.mockImplementation(() => {
      throw new Error('git unavailable');
    });

    await expect(listUserFacingReleases({ forceRefresh: true })).rejects.toThrow(
      /failed to load releases from github and no local tags/i,
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: { getGoogleStatus: vi.fn() },
}));

import { useGoogleStatus } from './useGoogleStatus';
import { api } from '../utils/api';

const mockApi = api as unknown as { getGoogleStatus: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockApi.getGoogleStatus.mockReset();
});

describe('useGoogleStatus', () => {
  it('exposes the connected status once it loads', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({ connected: true, grantedScopes: [] });

    const { result } = renderHook(() => useGoogleStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual({ connected: true, grantedScopes: [] });
  });

  it('falls back to a disconnected status when the request fails', async () => {
    // Best-effort: a failed status fetch must hide the surface, not throw.
    mockApi.getGoogleStatus.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useGoogleStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual({ connected: false });
  });
});

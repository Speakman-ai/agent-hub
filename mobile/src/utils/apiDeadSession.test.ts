// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror the mocks in api.test.ts, but hand back a real token so the
// dead-session token-clear path is exercised.
vi.mock('./config', () => ({
    getApiBaseUrl: () => 'https://example.test/api',
    getAuthHeaders: () => ({ 'X-API-Key': 'test-key' }),
}));
vi.mock('./uploadFile', () => ({
    uploadFile: vi.fn(async (ref: any) => ({ __mockedWith: ref })),
}));

const clearToken = vi.fn(async () => {});
vi.mock('./auth', () => ({
    getToken: () => 'jwt-token',
    clearToken: () => clearToken(),
}));

const { api } = await import('./api.js');

beforeEach(() => {
    clearToken.mockReset();
});

function mockFetchOnce(status: number, body: unknown) {
    globalThis.fetch = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    });
}

describe('mobile fetchJSON dead-session handling', () => {
    it('clears the token on a no_active_org_membership 403', async () => {
        mockFetchOnce(403, {
            error: 'You are not a member of this org.',
            code: 'no_active_org_membership',
        });
        await expect(api.getAgents()).rejects.toThrow(/403/);
        expect(clearToken).toHaveBeenCalledTimes(1);
    });

    it('leaves an ordinary permission 403 alone', async () => {
        mockFetchOnce(403, { error: 'Owner role required.' });
        await expect(api.getAgents()).rejects.toThrow(/403/);
        expect(clearToken).not.toHaveBeenCalled();
    });

    it('still clears the token on a 401', async () => {
        mockFetchOnce(401, { error: 'Token is no longer valid.' });
        await expect(api.getAgents()).rejects.toThrow(/401/);
        expect(clearToken).toHaveBeenCalledTimes(1);
    });
});

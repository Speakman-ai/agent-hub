import { describe, it, expect, vi } from 'vitest';
import {
  installContextFetchGuard,
  getContextFetchGuard,
  pausedRequestResourceType,
} from './browser-context-fetch-guard.js';

function makeCdpSession() {
  const handlers = new Map<string, (p: unknown) => void>();
  const send = vi.fn(async () => ({}));
  const session = {
    send,
    on: vi.fn((evt: string, h: (p: unknown) => void) => handlers.set(evt, h)),
    off: vi.fn((evt: string) => handlers.delete(evt)),
    detach: vi.fn(async () => {}),
  };
  return { session, send, handlers };
}

describe('pausedRequestResourceType', () => {
  it('prefers the top-level field, falls back to nested', () => {
    expect(
      pausedRequestResourceType({
        requestId: 'a',
        resourceType: 'Document',
        request: { url: 'x' },
      }),
    ).toBe('Document');
    expect(
      pausedRequestResourceType({ requestId: 'b', request: { url: 'x', resourceType: 'Script' } }),
    ).toBe('Script');
    expect(pausedRequestResourceType({ requestId: 'c', request: { url: 'x' } })).toBeUndefined();
  });
});

describe('installContextFetchGuard', () => {
  it('is the single Fetch owner: ad-block + document policy on one CDP session', async () => {
    const { session, send, handlers } = makeCdpSession();
    const context = {};
    const guard = await installContextFetchGuard(context, session, { blockAdsTrackers: true });
    expect(guard.installed).toBe(true);
    // Registered so navigate-time / preview callers discover it instead of
    // opening a second Fetch client.
    expect(getContextFetchGuard(context)).toBe(guard);
    expect(send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });

    const h = handlers.get('Fetch.requestPaused')!;

    // Ad/tracker host is failed for ANY resource type (no doc policy needed).
    h({
      requestId: 'ad',
      resourceType: 'Script',
      request: { url: 'https://stats.g.doubleclick.net/x.js' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'ad',
      errorReason: 'BlockedByClient',
    });

    // With no document policy set, a normal document just continues.
    h({ requestId: 'd0', resourceType: 'Document', request: { url: 'https://example.com/' } });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'd0' });
  });

  it('applies (and restores) the mutable document policy', async () => {
    const { session, send, handlers } = makeCdpSession();
    const guard = await installContextFetchGuard({}, session, { blockAdsTrackers: false });
    const h = handlers.get('Fetch.requestPaused')!;

    const restore = guard.setDocumentPolicy((url) => url.startsWith('http://localhost:4123/'));
    // Off-pin metadata SSRF target via a document navigation → failed before egress.
    h({
      requestId: 'm1',
      resourceType: 'Document',
      request: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.failRequest', {
      requestId: 'm1',
      errorReason: 'BlockedByClient',
    });
    // On-pin document continues.
    h({
      requestId: 'm2',
      resourceType: 'Document',
      request: { url: 'http://localhost:4123/settings' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'm2' });

    // A subresource is out of document-policy scope even off-pin.
    h({
      requestId: 'm3',
      resourceType: 'Script',
      request: { url: 'https://cdn.example.com/a.js' },
    });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'm3' });

    restore();
    // Policy reverted → the previously-blocked document now continues.
    send.mockClear();
    h({ requestId: 'm4', resourceType: 'Document', request: { url: 'https://example.com/' } });
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'm4' });
  });

  it('attaches the pause handler BEFORE enabling Fetch', async () => {
    const { session, handlers } = makeCdpSession();
    (session.send as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (...args: unknown[]) => {
        expect(args[0]).toBe('Fetch.enable');
        expect(handlers.has('Fetch.requestPaused')).toBe(true);
        return {};
      },
    );
    const guard = await installContextFetchGuard({}, session, { blockAdsTrackers: true });
    expect(guard.installed).toBe(true);
  });

  it('detaches and returns uninstalled when Fetch.enable fails', async () => {
    const { session, send, handlers } = makeCdpSession();
    send.mockRejectedValueOnce(new Error('Fetch domain unavailable'));
    const context = {};
    const guard = await installContextFetchGuard(context, session, { blockAdsTrackers: true });
    expect(guard.installed).toBe(false);
    expect(getContextFetchGuard(context)).toBeUndefined();
    expect(session.off).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
    expect(session.detach).toHaveBeenCalled();
    expect(handlers.has('Fetch.requestPaused')).toBe(false);
  });

  it('uninstall disables Fetch, detaches the CDP session, and unregisters', async () => {
    const { session, send } = makeCdpSession();
    const context = {};
    const guard = await installContextFetchGuard(context, session, { blockAdsTrackers: true });
    await guard.uninstall();
    expect(send).toHaveBeenCalledWith('Fetch.disable');
    expect(session.detach).toHaveBeenCalled();
    expect(session.off).toHaveBeenCalledWith('Fetch.requestPaused', expect.any(Function));
    expect(getContextFetchGuard(context)).toBeUndefined();
  });
});

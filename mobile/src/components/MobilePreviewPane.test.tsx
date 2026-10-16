import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';

const getSessionPreviewState = vi.fn(async () => ({ event: null }));
const mintSessionPreviewTicket = vi.fn(async () => ({ ticket: 't' }));
const startSessionPreview = vi.fn(async () => ({ ok: true }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('lucide-react-native', () => ({
  Maximize2: 'Maximize2',
  Minimize2: 'Minimize2',
  Monitor: 'Monitor',
  RefreshCw: 'RefreshCw',
  X: 'X',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.example' }));
vi.mock('../utils/api', () => ({
  api: { getSessionPreviewState, mintSessionPreviewTicket, startSessionPreview },
}));

const React = await import('react');
const { default: TestRenderer, act } = await import('react-test-renderer');
const { default: MobilePreviewPane } = await import('./MobilePreviewPane');
const { applyPreviewEvent } = await import('../utils/previewEvents');

function mount(props: Partial<React.ComponentProps<typeof MobilePreviewPane>> = {}) {
  const onToggleFullscreen = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <MobilePreviewPane
        sessionId="s1"
        fullscreen={false}
        onToggleFullscreen={onToggleFullscreen}
        {...props}
      />,
    );
  });
  return { renderer, onToggleFullscreen };
}

beforeEach(() => {
  getSessionPreviewState.mockClear();
  mintSessionPreviewTicket.mockClear();
  startSessionPreview.mockClear();
});

describe('MobilePreviewPane', () => {
  it('offers start while the session has no preview', () => {
    const { renderer } = mount();
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'No preview yet',
    );
    expect(renderer.root.findByProps({ testID: 'mobile-preview-start' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
  });

  it('loads a ready preview in a WebView and toggles fullscreen', async () => {
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    });
    await act(async () => {
      await Promise.resolve();
    });
    const web = renderer.root.findByProps({ testID: 'mobile-preview-webview' });
    expect(web.props.source.uri).toBe('http://hub.example:4173/');
    expect(mintSessionPreviewTicket).not.toHaveBeenCalled();
    act(() => {
      renderer.root.findByProps({ testID: 'toggle-preview-fullscreen' }).props.onPress();
    });
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it('labels the fullscreen control as a return to the session', () => {
    const { renderer } = mount({ fullscreen: true });
    expect(
      renderer.root.findByProps({ testID: 'toggle-preview-fullscreen' }).props.accessibilityLabel,
    ).toBe('Show session');
    expect(renderer.root.findByProps({ testID: 'mobile-preview-pane' }).props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ flex: 1 })]),
    );
  });

  it('does not fall back to a hydrated ready preview once the preview stops', async () => {
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(1);
    const stopped = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_stopped' });
    act(() => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s1"
          event={stopped.s1}
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'No preview yet',
    );
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'mobile-preview-start' })).toBeTruthy();
  });

  it('reloads a hydrated ready preview when a refresh arrives', async () => {
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    const before = renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri;
    const refreshed = applyPreviewEvent(
      {},
      { sessionId: 's1', kind: 'preview_refresh', refreshAt: 1234 },
    );
    act(() => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s1"
          event={refreshed.s1}
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    const after = renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri;
    expect(after).not.toBe(before);
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Live',
    );
  });

  it('retries the preview ticket from Reload after a failed request', async () => {
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'https://hub.example/api/sessions/s1/preview/proxy/' },
    } as any);
    mintSessionPreviewTicket
      .mockRejectedValueOnce(new Error('offline') as never)
      .mockResolvedValueOnce({ ticket: 'fresh' });
    const { renderer } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: 'mobile-preview-reload' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mintSessionPreviewTicket).toHaveBeenCalledTimes(2);
    const web = renderer.root.findByProps({ testID: 'mobile-preview-webview' });
    expect(web.props.source.uri).toContain('fresh');
  });

  it('shows a ready snapshot over a starting event cached before the pane opened', async () => {
    const cachedStarting = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' }).s1;
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount({ event: cachedStarting });
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Live',
    );
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(1);

    // A failure broadcast after the snapshot is newer and wins.
    const failed = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_failed' }).s1;
    act(() => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s1"
          event={failed}
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Failed',
    );
  });

  it('keeps a hydrated ready preview when a log line follows a cached starting event', async () => {
    const cached = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount({ event: cached.s1 });
    await act(async () => {
      await Promise.resolve();
    });
    const logged = applyPreviewEvent(cached, { sessionId: 's1', kind: 'preview_log', line: 'x' });
    act(() => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s1"
          event={logged.s1}
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Live',
    );
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(1);
  });

  it("drops the previous session's page when switching to one whose ticket fails", async () => {
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(1);

    const protectedUrl = 'https://hub.example/api/sessions/s2/preview/proxy/';
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: protectedUrl },
    } as any);
    mintSessionPreviewTicket.mockRejectedValueOnce(new Error('denied') as never);
    await act(async () => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s2"
          event={
            applyPreviewEvent({}, { sessionId: 's2', kind: 'preview', previewUrl: protectedUrl }).s2
          }
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(getSessionPreviewState).toHaveBeenLastCalledWith('s2');
    expect(mintSessionPreviewTicket).toHaveBeenCalledWith('s2');
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Live',
    );
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
  });

  it('drops the loaded page when the same session moves to a ticketed URL that fails', async () => {
    const { renderer, onToggleFullscreen } = mount();
    const at = (previewUrl: string) =>
      applyPreviewEvent({}, { sessionId: 's1', kind: 'preview', previewUrl }).s1;
    const show = async (event: any) => {
      await act(async () => {
        renderer.update(
          <MobilePreviewPane
            sessionId="s1"
            event={event}
            fullscreen={false}
            onToggleFullscreen={onToggleFullscreen}
          />,
        );
        await Promise.resolve();
      });
    };
    await show(at('http://localhost:4173/'));
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(1);
    mintSessionPreviewTicket.mockRejectedValueOnce(new Error('denied') as never);
    await show(at('https://hub.example/api/sessions/s1/preview/proxy/'));
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
  });

  it('opens a protected URL the user typed with its own ticket, over a pending one', async () => {
    let resolveInitial!: (v: any) => void;
    mintSessionPreviewTicket
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveInitial = r;
        }) as never,
      )
      .mockResolvedValueOnce({ ticket: 'for-settings' });
    const ticketed = applyPreviewEvent(
      {},
      {
        sessionId: 's1',
        kind: 'preview',
        previewUrl: 'https://hub.example/api/sessions/s1/preview/proxy/',
      },
    ).s1;
    getSessionPreviewState.mockResolvedValueOnce({ event: ticketed } as any);
    const { renderer } = mount({ event: ticketed });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mintSessionPreviewTicket).toHaveBeenCalledTimes(1);
    const typed = 'https://hub.example/api/sessions/s1/preview/proxy/settings?tab=2';
    act(() => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onChangeText(typed);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mintSessionPreviewTicket).toHaveBeenCalledTimes(2);
    // The first ticket arrives late; it must not replace the typed page.
    await act(async () => {
      resolveInitial({ ticket: 'late' });
      await Promise.resolve();
      await Promise.resolve();
    });
    const uri = new URL(
      renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri,
    );
    expect(uri.pathname).toBe('/api/sessions/s1/preview/proxy/settings');
    expect(uri.searchParams.get('tab')).toBe('2');
    expect(uri.searchParams.get('ticket')).toBe('for-settings');
    expect(renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.value).toBe(typed);
  });

  it('retries the ticket for a typed protected URL from Reload', async () => {
    const ticketed = applyPreviewEvent(
      {},
      { sessionId: 's1', kind: 'preview', previewUrl: 'http://localhost:4173/' },
    ).s1;
    getSessionPreviewState.mockResolvedValueOnce({ event: ticketed } as any);
    mintSessionPreviewTicket
      .mockRejectedValueOnce(new Error('offline') as never)
      .mockResolvedValueOnce({ ticket: 'retry' });
    const { renderer } = mount({ event: ticketed });
    await act(async () => {
      await Promise.resolve();
    });
    const typed = 'https://hub.example/api/sessions/s1/preview/proxy/a';
    act(() => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onChangeText(typed);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'mobile-preview-webview' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: 'mobile-preview-reload' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const uri = new URL(
      renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri,
    );
    expect(uri.pathname).toBe('/api/sessions/s1/preview/proxy/a');
    expect(uri.searchParams.get('ticket')).toBe('retry');
  });

  it('reloads a hydrated ready preview when a refresh lands on a cached starting event', async () => {
    const cached = applyPreviewEvent({}, { sessionId: 's1', kind: 'preview_starting' });
    getSessionPreviewState.mockResolvedValueOnce({
      event: { kind: 'preview', previewUrl: 'http://localhost:4173/' },
    } as any);
    const { renderer, onToggleFullscreen } = mount({ event: cached.s1 });
    await act(async () => {
      await Promise.resolve();
    });
    const before = renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri;
    const bumped = applyPreviewEvent(cached, {
      sessionId: 's1',
      kind: 'preview_refresh',
      refreshAt: 4321,
    });
    act(() => {
      renderer.update(
        <MobilePreviewPane
          sessionId="s1"
          event={bumped.s1}
          fullscreen={false}
          onToggleFullscreen={onToggleFullscreen}
        />,
      );
    });
    const after = renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri;
    expect(after).not.toBe(before);
    expect(renderer.root.findByProps({ testID: 'mobile-preview-status' }).props.children).toBe(
      'Live',
    );
  });

  it('never sends the preview ticket to a typed URL on another host', async () => {
    const ready = applyPreviewEvent(
      {},
      {
        sessionId: 's1',
        kind: 'preview',
        previewUrl: 'https://hub.example/api/sessions/s1/preview/proxy/',
      },
    ).s1;
    getSessionPreviewState.mockResolvedValueOnce({ event: ready } as any);
    mintSessionPreviewTicket.mockResolvedValue({ ticket: 'secret' });
    const { renderer } = mount({ event: ready });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    mintSessionPreviewTicket.mockClear();
    const evil = 'https://attacker.example/api/sessions/s1/preview/proxy/';
    act(() => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onChangeText(evil);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'mobile-preview-url' }).props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mintSessionPreviewTicket).not.toHaveBeenCalled();
    const uri = renderer.root.findByProps({ testID: 'mobile-preview-webview' }).props.source.uri;
    expect(uri).toBe(evil);
    expect(uri).not.toContain('secret');
  });
});

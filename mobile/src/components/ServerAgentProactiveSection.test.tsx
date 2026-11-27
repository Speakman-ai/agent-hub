import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProactivePrefsPatch } from '@shared/utils/proactivePrefsQueue';
import type { ServerAgentProactivePrefs } from '@shared/utils/serverAgentProactive';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const { default: TestRenderer, act } = await import('react-test-renderer');

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../utils/api', () => ({
  api: {
    getServerAgentProactive: vi.fn(),
    listServerAgentSuppressions: vi.fn(),
    putServerAgentProactive: vi.fn(),
    deleteServerAgentSuppression: vi.fn(),
    runServerAgentProactiveCheck: vi.fn(),
  },
}));

const { api } = (await import('../utils/api')) as unknown as {
  api: Record<string, ReturnType<typeof vi.fn>>;
};
const { DEFAULT_PROACTIVE_PREFS } = await import('@shared/utils/serverAgentProactive');
const { applyProactivePatch } = await import('@shared/utils/proactivePrefsQueue');
const { ServerAgentProactiveSection } = await import('./ServerAgentProactiveSection');

let renderer: ReactTestRenderer;
let server: ServerAgentProactivePrefs;
let calls: Array<{ patch: ProactivePrefsPatch; ok: () => void; fail: (e: Error) => void }>;

beforeEach(() => {
  server = { ...DEFAULT_PROACTIVE_PREFS, enabled: true, timeZone: 'UTC' };
  calls = [];
  api.getServerAgentProactive.mockReset().mockImplementation(async () => ({ prefs: server }));
  api.listServerAgentSuppressions.mockReset().mockResolvedValue({ suppressions: [] });
  api.putServerAgentProactive.mockReset().mockImplementation(
    (patch: ProactivePrefsPatch) =>
      new Promise((resolve, reject) => {
        calls.push({
          patch,
          ok: () => {
            server = applyProactivePatch(server, patch);
            resolve({ prefs: server });
          },
          fail: reject,
        });
      }),
  );
});
afterEach(() => act(() => renderer?.unmount()));

const sw = (testID: string) => renderer.root.findByProps({ testID });

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ServerAgentProactiveSection, {}));
  });
}

describe('mobile ServerAgentProactiveSection saving', () => {
  it('serializes saves and a slow response does not undo a newer toggle', async () => {
    await mount();
    act(() => sw('server-agent-proactive-area-dev').props.onValueChange(false));
    act(() => sw('server-agent-proactive-area-google').props.onValueChange(false));
    expect(api.putServerAgentProactive).toHaveBeenCalledTimes(1);
    expect(calls[0].patch).toEqual({ areas: { dev: false } });
    await act(async () => calls[0].ok());
    expect(sw('server-agent-proactive-area-google').props.value).toBe(false);
    expect(calls[1].patch).toEqual({ areas: { google: false } });
    await act(async () => calls[1].ok());
    expect(server.areas).toMatchObject({ dev: false, google: false, infra: true });
  });

  it('a failed save rolls back only its own change', async () => {
    await mount();
    act(() => sw('server-agent-proactive-area-dev').props.onValueChange(false));
    act(() => sw('server-agent-proactive-push').props.onValueChange(false));
    await act(async () => calls[0].fail(new Error('400: nope')));
    expect(sw('server-agent-proactive-area-dev').props.value).toBe(true);
    expect(sw('server-agent-proactive-push').props.value).toBe(false);
    await act(async () => calls[1].ok());
    expect(server.push).toBe(false);
    expect(sw('server-agent-proactive-area-dev').props.value).toBe(true);
  });
});

describe('mobile quiet-hours entry', () => {
  it('a save response arriving mid-typing keeps the unfinished time', async () => {
    await mount();
    act(() => sw('server-agent-proactive-area-dev').props.onValueChange(false));
    const start = () => sw('server-agent-proactive-quiet-start');
    act(() => start().props.onFocus());
    act(() => start().props.onChangeText('23:'));
    await act(async () => calls[0].ok());
    expect(start().props.value).toBe('23:');
    act(() => start().props.onChangeText('23:30'));
    act(() => start().props.onEndEditing());
    expect(calls[1].patch).toEqual({ quietHours: { start: '23:30' } });
    await act(async () => calls[1].ok());
    expect(start().props.value).toBe('23:30');
    expect(server.quietHours.start).toBe('23:30');
  });

  it('fields not being edited still pick up saved values', async () => {
    await mount();
    act(() => sw('server-agent-proactive-quiet-start').props.onFocus());
    act(() => sw('server-agent-proactive-quiet-start').props.onChangeText('2'));
    // An end-time save from elsewhere in the form lands while start is mid-edit.
    act(() => sw('server-agent-proactive-quiet-end').props.onChangeText('07:00'));
    act(() => sw('server-agent-proactive-quiet-end').props.onEndEditing());
    await act(async () => calls[0].ok());
    expect(sw('server-agent-proactive-quiet-start').props.value).toBe('2');
    expect(sw('server-agent-proactive-quiet-end').props.value).toBe('07:00');
  });
});

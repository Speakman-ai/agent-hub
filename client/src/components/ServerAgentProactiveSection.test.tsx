import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import {
  DEFAULT_PROACTIVE_PREFS,
  type ServerAgentProactivePrefs,
} from '@shared/utils/serverAgentProactive';
import { applyProactivePatch, type ProactivePrefsPatch } from '@shared/utils/proactivePrefsQueue';

(vi as any).mock('../utils/api', () => ({
  api: {
    getServerAgentProactive: vi.fn(),
    listServerAgentSuppressions: vi.fn(),
    putServerAgentProactive: vi.fn(),
    deleteServerAgentSuppression: vi.fn(),
    runServerAgentProactiveCheck: vi.fn(),
  },
}));

import { api } from '../utils/api';
import { ServerAgentProactiveSection } from './ServerAgentProactiveSection';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
let server: ServerAgentProactivePrefs;
let calls: Array<{ patch: ProactivePrefsPatch; ok: () => void; fail: (e: Error) => void }>;

beforeEach(() => {
  vi.resetAllMocks();
  server = { ...DEFAULT_PROACTIVE_PREFS, enabled: true, timeZone: 'UTC' };
  calls = [];
  mocked.getServerAgentProactive.mockImplementation(async () => ({
    prefs: server,
    state: { lastCheckAt: null, lastStatus: null, lastError: null, lastModelAt: null },
  }));
  mocked.listServerAgentSuppressions.mockResolvedValue({ suppressions: [] });
  mocked.putServerAgentProactive.mockImplementation(
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
afterEach(() => cleanup());

const box = (area: string) =>
  screen.getByTestId(`server-agent-proactive-area-${area}`) as HTMLInputElement;

describe('ServerAgentProactiveSection saving', () => {
  it('serializes saves, sends only the changed field, and keeps newer edits', async () => {
    render(<ServerAgentProactiveSection />);
    await screen.findByTestId('server-agent-proactive');
    fireEvent.click(box('dev'));
    fireEvent.click(box('google'));
    expect(box('dev').checked).toBe(false);
    expect(box('google').checked).toBe(false);
    expect(mocked.putServerAgentProactive).toHaveBeenCalledTimes(1);
    expect(calls[0].patch).toEqual({ areas: { dev: false } });

    calls[0].ok();
    await waitFor(() => expect(mocked.putServerAgentProactive).toHaveBeenCalledTimes(2));
    // The first response still has google on; the pending toggle must win.
    expect(box('google').checked).toBe(false);
    expect(calls[1].patch).toEqual({ areas: { google: false } });
    calls[1].ok();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'));
    expect(server.areas).toMatchObject({ dev: false, google: false, infra: true });
  });

  it('a failed save rolls back only its own change', async () => {
    render(<ServerAgentProactiveSection />);
    await screen.findByTestId('server-agent-proactive');
    fireEvent.click(box('dev'));
    fireEvent.click(screen.getByTestId('server-agent-proactive-push'));
    calls[0].fail(new Error('400: nope'));
    await waitFor(() => expect(mocked.putServerAgentProactive).toHaveBeenCalledTimes(2));
    expect(box('dev').checked).toBe(true);
    expect((screen.getByTestId('server-agent-proactive-push') as HTMLInputElement).checked).toBe(
      false,
    );
    calls[1].ok();
    await waitFor(() => expect(server.push).toBe(false));
    expect(box('dev').checked).toBe(true);
  });
});

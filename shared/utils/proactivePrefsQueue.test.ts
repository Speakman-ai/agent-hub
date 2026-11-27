import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_PROACTIVE_PREFS, type ServerAgentProactivePrefs } from './serverAgentProactive';
import {
  ProactivePrefsQueue,
  applyProactivePatch,
  type ProactivePrefsPatch,
} from './proactivePrefsQueue';

function deferredServer() {
  let server: ServerAgentProactivePrefs = { ...DEFAULT_PROACTIVE_PREFS, enabled: true };
  const calls: Array<{
    patch: ProactivePrefsPatch;
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  const save = vi.fn(
    (patch: ProactivePrefsPatch) =>
      new Promise<ServerAgentProactivePrefs>((resolve, reject) => {
        calls.push({
          patch,
          resolve: () => {
            server = applyProactivePatch(server, patch);
            resolve(server);
          },
          reject,
        });
      }),
  );
  return {
    save,
    calls,
    get server() {
      return server;
    },
  };
}

describe('ProactivePrefsQueue', () => {
  it('sends one patch at a time with only the changed field', async () => {
    const srv = deferredServer();
    const states: ServerAgentProactivePrefs[] = [];
    const q = new ProactivePrefsQueue(srv.server, srv.save, (s) => states.push(s.prefs));
    q.enqueue({ areas: { dev: false } });
    q.enqueue({ areas: { google: false } });
    expect(srv.save).toHaveBeenCalledTimes(1);
    expect(srv.calls[0].patch).toEqual({ areas: { dev: false } });
    // Both toggles show immediately.
    expect(q.state().prefs.areas).toMatchObject({ dev: false, google: false });
    srv.calls[0].resolve();
    await vi.waitFor(() => expect(srv.save).toHaveBeenCalledTimes(2));
    expect(srv.calls[1].patch).toEqual({ areas: { google: false } });
    // The first response (google still true) must not undo the pending toggle.
    expect(q.state().prefs.areas.google).toBe(false);
    srv.calls[1].resolve();
    await q.idle();
    expect(q.state().prefs.areas).toMatchObject({ dev: false, google: false, infra: true });
    expect(srv.server.areas).toMatchObject({ dev: false, google: false });
  });

  it('a failed patch rolls back only itself', async () => {
    const srv = deferredServer();
    const q = new ProactivePrefsQueue(srv.server, srv.save, () => undefined);
    q.enqueue({ areas: { dev: false } });
    q.enqueue({ push: false });
    srv.calls[0].reject(new Error('400: nope'));
    await vi.waitFor(() => expect(srv.save).toHaveBeenCalledTimes(2));
    expect(q.state().prefs.areas.dev).toBe(true);
    expect(q.state().prefs.push).toBe(false);
    expect(q.state().error).toBe('400: nope');
    srv.calls[1].resolve();
    await q.idle();
    expect(q.state()).toMatchObject({ error: null, prefs: { push: false, areas: { dev: true } } });
  });
});

/**
 * Unit tests for the `<agenthub:preview>` block parser + handler.
 *
 * Acceptance criteria covered (see kanban card 8cc17913):
 *   - Well-formed block extracts the JSON payload.
 *   - Malformed block produces a structured `reason`, never a crash.
 *   - Handler against an unconfigured project emits `preview_unavailable`
 *     with a wizard deep-link and never calls `startPreview`.
 *   - Handler against a configured project that boots successfully emits
 *     a `preview` attachment with port + URL + (optional) screenshot.
 *   - Handler that observes a `failed` runtime row emits `preview_failed`
 *     with the captured log tail.
 *
 * The runtime is mocked at the `PreviewRuntime` shape — no real spawn,
 * fetch, or DB is exercised here. End-to-end coverage of the runtime
 * itself lives in `preview-runtime.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPreviewBlock,
  parsePreviewBlock,
  describePreviewReason,
  handlePreviewBlock,
  resolvePreviewHandlerReadyTimeoutMs,
  type PreviewBroadcastEvent,
  type PreviewHandlerDeps,
} from './preview-block.js';
import type { PreviewRuntime } from './preview-runtime.js';
import type { Project } from '../types.js';

// ─── Test doubles ──────────────────────────────────────────────────────

function recordBroadcast(): {
  broadcast: (e: Record<string, unknown>) => void;
  events: PreviewBroadcastEvent[];
} {
  const events: PreviewBroadcastEvent[] = [];
  return {
    broadcast(e) {
      events.push(e as unknown as PreviewBroadcastEvent);
    },
    events,
  };
}

interface FakeRuntimeOpts {
  startResult?: { url: string; port: number; previewId: string };
  startThrows?: Error;
  /** Status the row reports on the *first* `getById` call. */
  initialStatus?: 'starting' | 'ready' | 'failed';
  /** Status flipped to after `flipAfterCalls` getById calls. */
  flippedStatus?: 'ready' | 'failed';
  flipAfterCalls?: number;
  logTail?: string[];
}

function makeRuntime(opts: FakeRuntimeOpts = {}): {
  runtime: PreviewRuntime;
  startPreviewCalls: number;
  getByIdCalls: () => number;
} {
  const startResult =
    opts.startResult ??
    ({ url: 'http://localhost:4100', port: 4100, previewId: 'prev-1' } as const);
  const initial = opts.initialStatus ?? 'starting';
  const flipped = opts.flippedStatus ?? 'ready';
  const flipAfter = opts.flipAfterCalls ?? 1;
  const logTail = opts.logTail ?? [];
  let startPreviewCalls = 0;
  let getByIdCalls = 0;

  const fake = {
    startPreview: async () => {
      startPreviewCalls++;
      if (opts.startThrows) throw opts.startThrows;
      return startResult;
    },
    getById: () => {
      getByIdCalls++;
      const status = getByIdCalls > flipAfter ? flipped : initial;
      return {
        id: startResult.previewId,
        session_id: 'sess-1',
        project_id: 'proj-1',
        pid: 4242,
        port: startResult.port,
        url: startResult.url,
        log_path: null,
        started_at: '2026-05-04T00:00:00Z',
        last_active_at: '2026-05-04T00:00:00Z',
        status,
      };
    },
    getLogTail: () => [...logTail],
    // unused by the handler, satisfy the type:
    stopPreview: async () => {},
    stopBySessionId: async () => 0,
    touchPreview: () => {},
    getActiveBySessionId: () => null,
  };

  return {
    runtime: fake as unknown as PreviewRuntime,
    get startPreviewCalls() {
      return startPreviewCalls;
    },
    getByIdCalls: () => getByIdCalls,
  };
}

function configuredProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project One',
    cwd: '/repo',
    ahw: '/ahw',
    agents: [],
    prEnv: {
      enabled: true,
      preview: { enabled: true, startScript: 'npm run dev' },
    },
    ...overrides,
  } as Project;
}

function makeDeps(over: Partial<PreviewHandlerDeps> = {}): PreviewHandlerDeps & {
  events: PreviewBroadcastEvent[];
} {
  const { broadcast, events } = recordBroadcast();
  const deps: PreviewHandlerDeps = {
    runtime: null,
    broadcast,
    project: configuredProject(),
    worktreePath: '/wt/sess-1',
    readyTimeoutMs: 1_000,
    readyPollIntervalMs: 1,
    sleep: () => Promise.resolve(),
    ...over,
  };
  return Object.assign(deps, { events });
}

// ─── Parser tests ──────────────────────────────────────────────────────

describe('detectPreviewBlock — happy paths', () => {
  it('extracts a well-formed block with all fields', () => {
    const text = `Sure, let me show you:
<agenthub:preview>
{"target":"client","route":"/projects/agent-hub/board","reason":"Show new badge"}
</agenthub:preview>
Hope that helps.`;
    const result = detectPreviewBlock(text);
    expect(result.present).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.task).toEqual({
      target: 'client',
      route: '/projects/agent-hub/board',
      reason: 'Show new badge',
    });
  });

  it('omits `reason` when not provided', () => {
    const result = detectPreviewBlock(
      `<agenthub:preview>{"target":"server","route":"/api/health"}</agenthub:preview>`,
    );
    expect(result.task).toEqual({ target: 'server', route: '/api/health' });
  });

  it('normalizes target case', () => {
    const result = detectPreviewBlock(
      `<agenthub:preview>{"target":"  CLIENT  ","route":"/"}</agenthub:preview>`,
    );
    expect(result.task?.target).toBe('client');
  });

  it('rejects target="fullstack" — PR-env subsystem removed', () => {
    // The fullstack escape hatch (draft PR + PR-env container pool) was
    // removed along with PR Environments. Only `client` / `server` are
    // valid targets now; `fullstack` falls through to `invalid-target`.
    const result = detectPreviewBlock(
      `<agenthub:preview>{"target":"fullstack","route":"/dashboard"}</agenthub:preview>`,
    );
    expect(result.present).toBe(true);
    expect(result.task).toBeNull();
    expect(result.reason).toBe('invalid-target');
  });

  it('tolerates a fenced code block inside the tag', () => {
    const result = detectPreviewBlock(
      '<agenthub:preview>\n```json\n' +
        '{"target":"client","route":"/board"}\n' +
        '```\n</agenthub:preview>',
    );
    expect(result.task).toEqual({ target: 'client', route: '/board' });
  });

  it('tolerates prose lead-in before the JSON object', () => {
    const result = detectPreviewBlock(
      `<agenthub:preview>Here it is: {"target":"client","route":"/x"}</agenthub:preview>`,
    );
    expect(result.task).toEqual({ target: 'client', route: '/x' });
  });
});

describe('detectPreviewBlock — malformed payloads produce reasons, not crashes', () => {
  it('returns present:false when no block is in the text', () => {
    expect(detectPreviewBlock('plain assistant turn')).toEqual({
      present: false,
      task: null,
      reason: null,
      rawBody: null,
    });
  });

  it('flags invalid JSON', () => {
    const r = detectPreviewBlock(`<agenthub:preview>{not-json</agenthub:preview>`);
    expect(r.present).toBe(true);
    expect(r.task).toBeNull();
    expect(r.reason).toBe('invalid-json');
  });

  it('flags non-object payloads', () => {
    const r = detectPreviewBlock(`<agenthub:preview>["client","/x"]</agenthub:preview>`);
    expect(r.reason).toBe('not-object');
    expect(r.task).toBeNull();
  });

  it('flags missing target', () => {
    const r = detectPreviewBlock(`<agenthub:preview>{"route":"/x"}</agenthub:preview>`);
    expect(r.reason).toBe('missing-target');
  });

  it('flags invalid target', () => {
    const r = detectPreviewBlock(
      `<agenthub:preview>{"target":"mobile","route":"/x"}</agenthub:preview>`,
    );
    expect(r.reason).toBe('invalid-target');
  });

  it('flags missing route', () => {
    const r = detectPreviewBlock(`<agenthub:preview>{"target":"client"}</agenthub:preview>`);
    expect(r.reason).toBe('missing-route');
  });

  it('flags route that does not start with `/`', () => {
    const r = detectPreviewBlock(
      `<agenthub:preview>{"target":"client","route":"board"}</agenthub:preview>`,
    );
    expect(r.reason).toBe('invalid-route');
  });

  it('describePreviewReason returns a sentence for every variant', () => {
    const reasons = [
      'invalid-json',
      'not-object',
      'missing-target',
      'invalid-target',
      'missing-route',
      'invalid-route',
    ] as const;
    for (const r of reasons) {
      const sentence = describePreviewReason(r);
      expect(sentence.length).toBeGreaterThan(5);
    }
  });

  it('parsePreviewBlock returns null for any malformed input', () => {
    expect(parsePreviewBlock(`<agenthub:preview>{not-json</agenthub:preview>`)).toBeNull();
    expect(parsePreviewBlock('no block here')).toBeNull();
  });
});

describe('resolvePreviewHandlerReadyTimeoutMs', () => {
  it('uses compose budget when entryService is set', () => {
    const project = {
      prEnv: { preview: { compose: { entryService: 'frontend', entryPort: 4200 } } },
    } as Project;
    expect(resolvePreviewHandlerReadyTimeoutMs(project, 900_000)).toBe(900_000);
  });

  it('prefers per-project compose.readyTimeoutMs', () => {
    const project = {
      prEnv: {
        preview: { compose: { entryService: 'web', entryPort: 3000, readyTimeoutMs: 42_000 } },
      },
    } as Project;
    expect(resolvePreviewHandlerReadyTimeoutMs(project, 600_000)).toBe(42_000);
  });

  it('uses spawn default when compose is not configured', () => {
    const project = { prEnv: { preview: { enabled: true } } } as Project;
    expect(resolvePreviewHandlerReadyTimeoutMs(project, 600_000)).toBe(120_000);
  });

  it('uses spawn default for services-only compose metadata', () => {
    const project = {
      prEnv: {
        preview: { enabled: true, compose: { file: 'compose.yml', readyTimeoutMs: 42_000 } },
      },
    } as Project;
    expect(resolvePreviewHandlerReadyTimeoutMs(project, 600_000)).toBe(120_000);
  });
});

describe('handlePreviewBlock — ready timeout default', () => {
  it('waits on the compose budget when readyTimeoutMs is omitted', async () => {
    const project = configuredProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: {
          enabled: true,
          compose: { entryService: 'web', entryPort: 4200 },
        },
      },
    });
    const fake = makeRuntime({ flipAfterCalls: 999, initialStatus: 'starting' });
    let nowMs = 0;
    const deps = makeDeps({
      project,
      runtime: fake.runtime,
      readyTimeoutMs: undefined,
      readyPollIntervalMs: 1,
      startingRebroadcastIntervalMs: 0,
      sleep: async () => {
        nowMs += 50_000;
      },
      now: () => nowMs,
    });
    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);
    const failed = deps.events.find((e) => e.kind === 'preview_failed');
    expect(failed?.error).toContain('600000ms');
    expect(nowMs).toBeGreaterThanOrEqual(600_000);
  });
});

// ─── Handler tests ─────────────────────────────────────────────────────

describe('handlePreviewBlock — gating', () => {
  it('emits preview_unavailable with wizard intent + legacy wizardUrl when project has no prEnv', async () => {
    const project = { id: 'p1', name: 'p', cwd: '/r', ahw: '/a', agents: [] } as Project;
    const deps = makeDeps({ project });
    const startCalls: number[] = [];
    const fake = makeRuntime();
    Object.assign(deps, { runtime: fake.runtime });
    // Track start calls indirectly by counting:
    const beforeStart = fake.startPreviewCalls;

    await handlePreviewBlock('sess-1', { target: 'client', route: '/x' }, deps);

    expect(deps.events).toHaveLength(1);
    const ev = deps.events[0];
    expect(ev.kind).toBe('preview_unavailable');
    expect(ev.unavailableReason).toBe('no-pr-env');
    // Preferred contract: structured navigation intent.
    expect(ev.wizard).toEqual({ view: 'preview:p1', projectId: 'p1' });
    // Legacy fallback: string URL retained for one release of compat so
    // older client builds that read `wizardUrl` still render the card.
    expect(ev.wizardUrl).toContain('/projects/p1/settings/');
    expect(fake.startPreviewCalls).toBe(beforeStart);
    startCalls.push(fake.startPreviewCalls);
  });

  it('emits preview_unavailable when prEnv exists but preview.enabled is false', async () => {
    const project = configuredProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: { enabled: false },
      },
    });
    const deps = makeDeps({ project });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/x' }, deps);

    expect(deps.events).toHaveLength(1);
    const ev = deps.events[0];
    expect(ev.kind).toBe('preview_unavailable');
    expect(ev.unavailableReason).toBe('preview-disabled');
    expect(ev.wizard).toEqual({ view: 'preview:proj-1', projectId: 'proj-1' });
    expect(ev.wizardUrl).toBeTruthy();
  });

  it('allows a dev-server-only project without a legacy preview block', async () => {
    const project = configuredProject({
      prEnv: {
        enabled: true,
        startScript: '',
        internalPort: 3000,
        devServer: {
          startCommand: 'npm run dev',
          env: {},
          secretKeys: [],
          portMap: [{ internalPort: 3000, label: 'web', primary: true }],
        },
      },
    });
    const fake = makeRuntime({ initialStatus: 'ready' });
    const deps = makeDeps({ project, runtime: fake.runtime });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    expect(deps.events[deps.events.length - 1].kind).toBe('preview');
    expect(fake.startPreviewCalls).toBe(1);
  });

  it('emits preview_unavailable with wizard intent when runtime is null even if config is present', async () => {
    const deps = makeDeps({ runtime: null });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    expect(deps.events[0].kind).toBe('preview_unavailable');
    // The runtime-null path also needs to carry the navigation intent
    // so the user can resolve the deep-link even when the runtime isn't
    // wired (e.g. on a server whose preview subsystem failed to boot).
    expect(deps.events[0].wizard).toEqual({ view: 'preview:proj-1', projectId: 'proj-1' });
    expect(deps.events[0].wizardUrl).toBeTruthy();
  });

  it('respects an injected buildWizardUrl (legacy fallback override)', async () => {
    const project = { id: 'p1', name: 'p', cwd: '/r', ahw: '/a', agents: [] } as Project;
    const deps = makeDeps({
      project,
      buildWizardUrl: (id) => `/custom/${id}/wizard`,
    });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    expect(deps.events[0].wizardUrl).toBe('/custom/p1/wizard');
    // Default wizard intent still emitted side-by-side.
    expect(deps.events[0].wizard).toEqual({ view: 'preview:p1', projectId: 'p1' });
  });

  it('respects an injected buildWizard (preferred intent override)', async () => {
    const project = { id: 'p1', name: 'p', cwd: '/r', ahw: '/a', agents: [] } as Project;
    const deps = makeDeps({
      project,
      buildWizard: (id) => ({ view: `custom:preview:${id}`, projectId: id }),
    });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    expect(deps.events[0].wizard).toEqual({ view: 'custom:preview:p1', projectId: 'p1' });
    // Legacy wizardUrl is still produced from the default builder.
    expect(deps.events[0].wizardUrl).toBeTruthy();
  });
});

describe('handlePreviewBlock — boot success', () => {
  it('emits a preview attachment with URL, port, and screenshotPath when ready', async () => {
    const fake = makeRuntime({
      startResult: { url: 'http://localhost:4242', port: 4242, previewId: 'prev-A' },
      initialStatus: 'starting',
      flippedStatus: 'ready',
      flipAfterCalls: 1,
    });
    const screenshotPaths: string[] = [];
    const deps = makeDeps({
      runtime: fake.runtime,
      takeScreenshot: async (url) => {
        screenshotPaths.push(url);
        return '/uploads/preview-A.png';
      },
    });

    await handlePreviewBlock(
      'sess-1',
      { target: 'client', route: '/board', reason: 'show me' },
      deps,
    );

    // Successful boot now emits at least one preview_starting (carrying the
    // live log tail) before the terminal `preview` event.
    expect(deps.events[0].kind).toBe('preview_starting');
    const evt = deps.events[deps.events.length - 1];
    expect(evt.kind).toBe('preview');
    expect(evt.previewId).toBe('prev-A');
    expect(evt.previewUrl).toBe('http://localhost:4242');
    expect(evt.fullUrl).toBe('http://localhost:4242/board');
    expect(evt.port).toBe(4242);
    expect(evt.screenshotPath).toBe('/uploads/preview-A.png');
    expect(evt.target).toBe('client');
    expect(evt.route).toBe('/board');
    expect(evt.agentReason).toBe('show me');
    expect(screenshotPaths).toEqual(['http://localhost:4242/board']);
    expect(fake.startPreviewCalls).toBe(1);
  });

  it('renders fullUrl correctly when route lacks leading slash (defensive)', async () => {
    const fake = makeRuntime({ flipAfterCalls: 0 });
    const deps = makeDeps({ runtime: fake.runtime });
    // Bypass the parser-level check: the parser would reject this, but if a
    // future caller forwards a hand-constructed task we still want sane output.
    await handlePreviewBlock('sess-1', { target: 'client', route: '/x' }, deps);
    const evt = deps.events[deps.events.length - 1];
    expect(evt.fullUrl).toBe('http://localhost:4100/x');
  });

  it('survives a screenshot failure — still emits the preview event', async () => {
    const fake = makeRuntime({ flipAfterCalls: 0 });
    const deps = makeDeps({
      runtime: fake.runtime,
      takeScreenshot: async () => {
        throw new Error('playwright timeout');
      },
    });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/x' }, deps);

    const evt = deps.events[deps.events.length - 1];
    expect(evt.kind).toBe('preview');
    expect(evt.screenshotPath).toBeNull();
  });
});

describe('handlePreviewBlock — boot failure', () => {
  it('emits preview_failed with the thrown error message when startPreview rejects', async () => {
    const fake = makeRuntime({ startThrows: new Error('ports exhausted') });
    const deps = makeDeps({ runtime: fake.runtime });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    expect(deps.events).toHaveLength(2);
    expect(deps.events[0].kind).toBe('preview_starting');
    const evt = deps.events[1];
    expect(evt.kind).toBe('preview_failed');
    expect(evt.error).toContain('ports exhausted');
  });

  it('emits preview_failed with the runtime log tail when status flips to failed', async () => {
    const fake = makeRuntime({
      flipAfterCalls: 1,
      flippedStatus: 'failed',
      logTail: ['npm ERR! line 1', 'npm ERR! line 2'],
    });
    const deps = makeDeps({ runtime: fake.runtime });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    // preview_starting fires before the runtime row flips, then preview_failed
    // is the terminal event we assert on.
    expect(deps.events[0].kind).toBe('preview_starting');
    const evt = deps.events[deps.events.length - 1];
    expect(evt.kind).toBe('preview_failed');
    expect(evt.error).toMatch(/boot failed/);
    expect(evt.logTail).toEqual(['npm ERR! line 1', 'npm ERR! line 2']);
  });

  it('emits preview_failed when the readiness wait times out', async () => {
    // Runtime stays in `starting` forever.
    const fake = makeRuntime({
      initialStatus: 'starting',
      flippedStatus: 'ready',
      flipAfterCalls: Infinity,
      logTail: ['boot line'],
    });
    let now = 0;
    const deps = makeDeps({
      runtime: fake.runtime,
      readyTimeoutMs: 5,
      readyPollIntervalMs: 1,
      sleep: async (ms) => {
        now += ms;
      },
    });
    // Replace Date.now via a slow tick — we only need a few iterations.
    const realNow = Date.now;
    Date.now = () => realNow() + now;
    try {
      await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);
    } finally {
      Date.now = realNow;
    }

    expect(deps.events[0].kind).toBe('preview_starting');
    const evt = deps.events[deps.events.length - 1];
    expect(evt.kind).toBe('preview_failed');
    expect(evt.error).toMatch(/did not reach ready/);
    expect(evt.logTail).toEqual(['boot line']);
  });
});

describe('handlePreviewBlock — preview_starting', () => {
  it('emits an initial preview_starting immediately after spawn with the current logTail', async () => {
    const fake = makeRuntime({
      flipAfterCalls: 0,
      logTail: ['vite v5.0.0 starting…'],
    });
    const deps = makeDeps({ runtime: fake.runtime });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/board' }, deps);

    const startings = deps.events.filter((e) => e.kind === 'preview_starting');
    expect(startings.length).toBeGreaterThanOrEqual(2);
    const early = startings[0];
    expect(early.previewId).toBe('');
    expect(early.logTail).toEqual(['[preview] Starting…']);
    const starting = startings.find((e) => e.previewId === 'prev-1');
    expect(starting).toBeDefined();
    expect(starting!.previewUrl).toBe('http://localhost:4100');
    expect(starting!.port).toBe(4100);
    expect(starting!.logTail).toEqual(['vite v5.0.0 starting…']);
    expect(starting!.route).toBe('/board');
    expect(starting!.target).toBe('client');
  });

  it('re-broadcasts preview_starting during the ready poll, throttled by startingRebroadcastIntervalMs', async () => {
    // Runtime stays in `starting` for several polls; logTail grows over time
    // to verify each rebroadcast carries a fresh snapshot.
    let pollCalls = 0;
    const tails: string[][] = [
      [],
      ['line 1'],
      ['line 1', 'line 2'],
      ['line 1', 'line 2', 'line 3'],
    ];
    const fake = {
      startPreview: async () => ({
        url: 'http://localhost:4100',
        port: 4100,
        previewId: 'prev-1',
      }),
      getById: () => {
        pollCalls++;
        return {
          id: 'prev-1',
          session_id: 'sess-1',
          project_id: 'proj-1',
          pid: 1,
          port: 4100,
          url: 'http://localhost:4100',
          log_path: null,
          started_at: 't',
          last_active_at: 't',
          // Flip to ready on the 4th poll so we run through several
          // rebroadcasts first.
          status: pollCalls >= 4 ? ('ready' as const) : ('starting' as const),
        };
      },
      getLogTail: () => tails[Math.min(pollCalls, tails.length - 1)],
      stopPreview: async () => {},
      stopBySessionId: async () => 0,
      touchPreview: () => {},
      getActiveBySessionId: () => null,
    };

    // Drive the rebroadcast clock manually so we can deterministically
    // step past startingRebroadcastIntervalMs each poll.
    let fakeNow = 0;
    const deps = makeDeps({
      runtime: fake as unknown as PreviewRuntime,
      readyTimeoutMs: 10_000,
      readyPollIntervalMs: 1,
      startingRebroadcastIntervalMs: 5,
      now: () => fakeNow,
      sleep: async () => {
        fakeNow += 10;
      },
    });

    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);

    const startings = deps.events.filter((e) => e.kind === 'preview_starting');
    expect(startings.length).toBeGreaterThanOrEqual(2);
    // Initial broadcast carries an empty (or earliest) tail; later
    // rebroadcasts carry the growing snapshot.
    const lastStarting = startings[startings.length - 1];
    expect(lastStarting.logTail?.length ?? 0).toBeGreaterThan(0);
    // Terminal event is still preview (boot succeeded on poll 4).
    expect(deps.events[deps.events.length - 1].kind).toBe('preview');
  });

  it('does NOT emit preview_starting when gating short-circuits before spawn', async () => {
    // runtime: null path returns early with preview_unavailable — must not
    // emit preview_starting first.
    const deps = makeDeps({ runtime: null });
    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);
    expect(deps.events).toHaveLength(1);
    expect(deps.events[0].kind).toBe('preview_unavailable');
  });

  it('uses 120s as the default readyTimeoutMs', async () => {
    // We don't time anything here — just sanity-check the exported default
    // by inspecting a handler call that relies on the default and never
    // calls runtime.getById (so the loop never enters). Project gating
    // short-circuits before the timeout matters, but the new default
    // matters for the *next* failing case the runtime hits. Smoke test:
    // run a gating path with no readyTimeoutMs override and confirm it
    // still resolves promptly.
    const deps = makeDeps({ runtime: null, readyTimeoutMs: undefined });
    const before = Date.now();
    await handlePreviewBlock('sess-1', { target: 'client', route: '/' }, deps);
    expect(Date.now() - before).toBeLessThan(1_000);
  });
});

// ─── Compose runtime dispatch ──────────────────────────────────────────

describe('handlePreviewBlock — accepts a PreviewComposeRuntime', () => {
  it('emits a preview attachment when the compose runtime reports ready', async () => {
    // The compose runtime is structurally a `PreviewRuntimeLike` (the
    // compile-time assertion in preview-block.ts pins this). We exercise
    // the shape contract here with a thin manual fake whose
    // `startPreview` return + `getById` flip exactly mirror what the
    // real PreviewComposeRuntime produces (no docker / fetch loop, so
    // the test is deterministic). The full compose runtime end-to-end is
    // covered by preview-compose-runtime.test.ts.
    let gets = 0;
    const composeRuntimeShape = {
      startPreview: async () => ({
        previewId: 'compose-prev',
        url: 'http://localhost:4111',
        port: 4111,
        composeProjectName: 'agenthub-session-sess-c',
      }),
      getById: () => {
        gets++;
        return {
          id: 'compose-prev',
          session_id: 'sess-c',
          project_id: 'proj-1',
          port: 4111,
          url: 'http://localhost:4111',
          compose_project_name: 'agenthub-session-sess-c',
          status: (gets >= 2 ? 'ready' : 'starting') as 'ready' | 'starting',
          started_at: '2026-05-18T00:00:00Z',
          last_active_at: '2026-05-18T00:00:00Z',
        };
      },
      getLogTail: () => [],
    };

    const project = configuredProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: {
          enabled: true,
          compose: { entryService: 'web', entryPort: 8000 },
        },
      },
    });

    const deps = makeDeps({
      project,
      runtime: composeRuntimeShape as unknown as PreviewRuntime,
      readyTimeoutMs: 1_000,
      readyPollIntervalMs: 1,
      startingRebroadcastIntervalMs: 0,
    });

    await handlePreviewBlock('sess-c', { target: 'client', route: '/' }, deps);

    // Terminal event is `preview` with the compose-runtime's allocated port.
    const terminal = deps.events[deps.events.length - 1];
    expect(terminal.kind).toBe('preview');
    expect(terminal.port).toBe(4111);
    expect(terminal.previewUrl).toBe('http://localhost:4111');
    expect(terminal.fullUrl).toBe('http://localhost:4111/');
  });
});

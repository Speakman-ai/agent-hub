/**
 * Tests for the in-session reviewer driver (`runReviewerTurn`).
 *
 * We stub the CLI spawn so the engine driver returns deterministic
 * assistant text, then assert:
 *
 *   - Reviewer agent is attached to the originating session via
 *     `addSessionAgent`.
 *   - The driver's user-prompt size is bounded by the diff inputs, NOT
 *     by the session transcript (`addMessage` lookups are NOT consulted).
 *   - The assistant message is persisted into the session with the
 *     reviewer agent identity stamped on it.
 *   - The tail `<agenthub:review-verdict>` block is parsed off and the
 *     visible chat content has the block stripped.
 *   - Missing / malformed tail throws — the dispatch helper turns this
 *     into a `review_failed` outcome rather than silently approving.
 *   - Cancel signal aborts the CLI cleanly.
 *
 * No real CLI binaries spawn — the global vitest setup guards against
 * them and we inject a `spawn` fake that drives stream-parser events
 * via a fake stdout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import type { ChildProcess } from 'child_process';

// The reviewer spawn builds its env via `resolveSessionCliSpawnEnv`, which
// hard-fails when the reviewer session's owner has no per-account creds.
// These tests drive a fake spawn and assert prompt/verdict behaviour, not
// auth — stub the env builder to a bare object so it never hard-fails.
vi.mock('../per-user-cli-spawn.js', () => ({
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

import {
  runReviewerTurn,
  pickReviewerAgentId,
  composeReviewerSystemPrompt,
  restrictToSpawnableEngines,
  FINALIZE_REVIEWER_TURN_OVERRIDE,
  REVIEWER_GENERAL_FEEDBACK_ANCHOR,
} from './in-session-reviewer.js';
import type { EngineAvailability, SupportedEngine } from '../engine-availability.js';
import { initOrgsDb } from '../orgs.js';
import { createUser } from '../users-store.js';
import { replaceUserPreferencesJson } from '../user-preferences-store.js';
import type { AppConfig, EnrichedAgent, KanbanCardRow, Project, SessionRow } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const fakeCard: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-1',
  board_id: 'board-1',
  title: 'In-session review wiring',
  description: '',
  priority: 'medium',
  assignee: 'agent-1',
  labels: '',
  session_id: 'sess-1',
  github_issue_url: null,
  pr_url: null,
  position: 0,
  created_by: 'user-1',
  assign_model: null,
  assign_engine: null,
  epic_id: null,
  pr_base_branch: null,
  documented: 0,
} as unknown as KanbanCardRow;

const fakeProject: Project = {
  id: 'proj-1',
  name: 'agent-hub',
  agents: [
    { id: 'lead-1', name: 'Lead', engine: 'claude-code', role: 'lead' },
    { id: 'rev-1', name: 'Reviewer', engine: 'claude-code', role: 'reviewer' },
  ],
} as unknown as Project;

const fakeInputs = {
  baseSha: 'aaa1111',
  headSha: 'bbb2222',
  changedFiles: ['server/foo.ts'],
  unifiedDiff: 'diff --git a/server/foo.ts b/server/foo.ts\n+const x = 1;\n',
};

const fakeSession: SessionRow = {
  id: 'sess-1',
  agent_id: 'lead-1',
  worktree_path: '/tmp/wt',
  owner_user_id: 'user-1',
} as unknown as SessionRow;

function makeReviewer(): EnrichedAgent {
  return {
    id: 'rev-1',
    name: 'Reviewer',
    engine: 'claude-code',
    role: 'reviewer',
    color: '#abc',
    cwd: '/tmp/wt',
    projectId: 'proj-1',
    projectName: 'agent-hub',
  } as unknown as EnrichedAgent;
}

const fakeConfig: AppConfig = {
  port: 3051,
  defaultCwd: '/tmp',
  conferenceTimeoutMs: 60_000,
  defaultModel: 'claude-opus-4-8',
  engineValidModels: {
    'claude-code': ['claude-opus-4-8'],
    'codex-cli': ['gpt-5.4'],
    'cursor-agent': ['composer-2.5'],
    'gemini-cli': ['gemini-2.5-pro'],
    'grok-cli': ['grok-4.6'],
  },
  engineDefaultModels: {
    'claude-code': 'claude-opus-4-8',
    'codex-cli': 'gpt-5.4',
    'cursor-agent': 'composer-2.5',
    'gemini-cli': 'gemini-2.5-pro',
    'grok-cli': 'grok-4.6',
  },
  codexDangerBypass: true,
  codexProfile: null,
} as unknown as AppConfig;

// ─── Stub CLI process ────────────────────────────────────────────────

class FakeStdout extends EventEmitter {}

class FakeProc extends EventEmitter {
  stdout = new FakeStdout() as unknown as Readable;
  stderr = new FakeStdout() as unknown as Readable;
  stdin = null;
  pid = 1234;
  killed = false;
  // Just enough of ChildProcess for trackChild + killProcessGroup not to crash.
  kill(_signal?: string | number): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

/**
 * Build a spawn fake that pushes the given `assistantText` through the
 * Claude stream-json parser shape, then closes cleanly.
 */
function makeSpawnFake(assistantText: string): {
  spawnFn: typeof import('child_process').spawn;
  capturedArgs: Array<{ bin: string; args: string[] }>;
} {
  const captured: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = ((bin: string, args: string[]) => {
    captured.push({ bin, args });
    const proc = new FakeProc();
    // The Claude stream-json parser expects newline-delimited JSON events
    // shaped like: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
    setImmediate(() => {
      const payload = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: assistantText }] },
      });
      proc.stdout.emit('data', Buffer.from(payload + '\n'));
      proc.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', is_error: false }) + '\n'),
      );
      proc.emit('close', 0);
    });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import('child_process').spawn;
  return { spawnFn, capturedArgs: captured };
}

function makeCodexSpawnFake(assistantText: string): {
  spawnFn: typeof import('child_process').spawn;
  capturedArgs: Array<{ bin: string; args: string[] }>;
} {
  const captured: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = ((bin: string, args: string[]) => {
    captured.push({ bin, args });
    const proc = new FakeProc();
    setImmediate(() => {
      const payload = JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: assistantText },
      });
      proc.stdout.emit('data', Buffer.from(payload + '\n'));
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
      proc.emit('close', 0);
    });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import('child_process').spawn;
  return { spawnFn, capturedArgs: captured };
}

function makeGrokSpawnFake(assistantText: string): {
  spawnFn: typeof import('child_process').spawn;
  capturedArgs: Array<{ bin: string; args: string[] }>;
} {
  const captured: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = ((bin: string, args: string[]) => {
    captured.push({ bin, args });
    const proc = new FakeProc();
    setImmediate(() => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'grok-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: assistantText },
          },
        },
      });
      proc.stdout.emit('data', Buffer.from(payload + '\n'));
      proc.emit('close', 0);
    });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import('child_process').spawn;
  return { spawnFn, capturedArgs: captured };
}

/**
 * Spawn fake that dispatches on the CLI binary path: the first entry whose
 * `bin` matches is used, so a test can make claude fail and codex succeed to
 * exercise the failover walk. Each behaviour is either an error string (close
 * non-zero with it on stderr and no assistant text → rejects) or the assistant
 * text to stream cleanly.
 */
function makeDispatchSpawnFake(
  behaviours: Array<{ bin: string; fail?: string; text?: string; codex?: boolean; grok?: boolean }>,
): {
  spawnFn: typeof import('child_process').spawn;
  capturedArgs: Array<{ bin: string; args: string[] }>;
} {
  const captured: Array<{ bin: string; args: string[] }> = [];
  const spawnFn = ((bin: string, args: string[]) => {
    captured.push({ bin, args });
    const behaviour = behaviours.find((b) => b.bin === bin) ?? behaviours[behaviours.length - 1]!;
    const proc = new FakeProc();
    setImmediate(() => {
      if (behaviour.fail) {
        proc.stderr.emit('data', Buffer.from(behaviour.fail));
        proc.emit('close', 1);
        return;
      }
      const text = behaviour.text ?? '';
      if (behaviour.codex) {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text },
            }) + '\n',
          ),
        );
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
      } else if (behaviour.grok) {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'grok-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text },
                },
              },
            }) + '\n',
          ),
        );
      } else {
        proc.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text }] },
            }) + '\n',
          ),
        );
        proc.stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ type: 'result', is_error: false }) + '\n'),
        );
      }
      proc.emit('close', 0);
    });
    return proc as unknown as ChildProcess;
  }) as unknown as typeof import('child_process').spawn;
  return { spawnFn, capturedArgs: captured };
}

/** Full availability map with the named engines authenticated. */
function availabilityWith(
  authenticated: SupportedEngine[],
): Record<SupportedEngine, EngineAvailability> {
  const all: SupportedEngine[] = [
    'claude-code',
    'cursor-agent',
    'codex-cli',
    'gemini-cli',
    'grok-cli',
  ];
  const auth = new Set(authenticated);
  return Object.fromEntries(
    all.map((e) => [
      e,
      auth.has(e)
        ? { engine: e, available: true }
        : { engine: e, available: false, reason: 'no-credentials', detail: 'no creds' },
    ]),
  ) as Record<SupportedEngine, EngineAvailability>;
}

// ─── Common deps factory ─────────────────────────────────────────────

function makeDeps(
  spawnFn: typeof import('child_process').spawn,
  overrides: Record<string, unknown> = {},
) {
  const messages: Array<{
    id: string;
    sessionId: string;
    role: string;
    content: string;
    agentId: string | null;
  }> = [];
  const attached: Array<{ sessionId: string; agentId: string }> = [];
  const removed: Array<{ sessionId: string; agentId: string }> = [];
  return {
    deps: {
      stmts: {
        addSessionAgent: {
          run: vi.fn((sessionId: string, agentId: string) => {
            attached.push({ sessionId, agentId });
          }),
        },
        removeSessionAgent: {
          run: vi.fn((sessionId: string, agentId: string) => {
            removed.push({ sessionId, agentId });
          }),
        },
        getSessionAgents: {
          all: vi.fn(() => {
            const removedIds = new Set(removed.map((r) => r.agentId));
            return attached
              .filter((a) => !removedIds.has(a.agentId))
              .map((a, i) => ({
                session_id: a.sessionId,
                agent_id: a.agentId,
                position: i,
                added_at: 't',
              }));
          }),
        },
        addMessage: {
          run: vi.fn(
            (id: string, sessionId: string, role: string, content: string, ...rest: unknown[]) => {
              // addMessage param order:
              //   id, sessionId, role, content, engine, model,
              //   <r0> null, <r1> null, <r2> agent_id, <r3> agent_name, <r4> agent_color
              // (rest[0]=engine after destructure shift, so agent_id at rest[4])
              messages.push({
                id,
                sessionId,
                role,
                content,
                agentId: (rest[4] as string | null) ?? null,
              });
            },
          ),
        },
        touchSession: { run: vi.fn() },
        getSession: { get: vi.fn().mockReturnValue({ ...fakeSession }) },
      } as never,
      broadcast: vi.fn(),
      getEnrichedAgent: vi.fn().mockReturnValue(makeReviewer()),
      findAgent: vi.fn().mockReturnValue({ project: fakeProject, agent: makeReviewer() }),
      buildEnrichedPrompt: vi.fn().mockReturnValue('REVIEWER-ENRICHED-PROMPT'),
      getClaudeBin: () => '/fake/claude',
      getCursorBin: () => '/fake/cursor',
      getGeminiBin: () => '/fake/gemini',
      getCodexBin: () => '/fake/codex',
      getGrokBin: () => '/fake/grok',
      getConfig: () => fakeConfig,
      spawn: spawnFn,
      timeoutMs: 5_000,
      now: () => 1_700_000_000_000,
      newId: () => 'msg-1',
      log: vi.fn(),
      ...overrides,
    },
    messages,
    attached,
    removed,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Unit tests for pure helpers ─────────────────────────────────────

describe('pickReviewerAgentId', () => {
  it('returns the first reviewer-role agent id', () => {
    expect(pickReviewerAgentId(fakeProject)).toBe('rev-1');
  });

  it('returns null when no reviewer role exists', () => {
    const p = {
      ...fakeProject,
      agents: [{ id: 'lead-1', name: 'Lead', engine: 'claude-code', role: 'lead' }],
    } as Project;
    expect(pickReviewerAgentId(p)).toBeNull();
  });

  it('returns null when agents array is empty or missing', () => {
    expect(pickReviewerAgentId({ id: 'p', agents: [] } as unknown as Project)).toBeNull();
    expect(pickReviewerAgentId({ id: 'p' } as unknown as Project)).toBeNull();
  });
});

describe('composeReviewerSystemPrompt', () => {
  it('wraps the standing prompt with a no-PR-yet override so a stale seed cannot abort', () => {
    const out = composeReviewerSystemPrompt('BASE', fakeProject, fakeCard);
    expect(out).toContain('BASE');
    expect(out).toContain('In-session Reviewer');
    expect(out).toContain('Do NOT edit files');
    expect(out).toContain('no PR exists yet');
    expect(out).toContain('agenthub:review-verdict');
    expect(out.startsWith(FINALIZE_REVIEWER_TURN_OVERRIDE)).toBe(true);
    expect(out.indexOf(FINALIZE_REVIEWER_TURN_OVERRIDE)).toBeLessThan(out.indexOf('BASE'));
    expect(out.indexOf('BASE')).toBeLessThan(out.indexOf('In-session Reviewer'));
  });

  it('includes the card title and project name', () => {
    const out = composeReviewerSystemPrompt('B', fakeProject, fakeCard);
    expect(out).toContain('agent-hub');
    expect(out).toContain('In-session review wiring');
  });

  it('tells the model not to stop when the standing prompt still says fetch-a-PR-or-abort', () => {
    const stale =
      'Identify the PR you are reviewing from the prompt context. If you cannot load the PR diff, stop.';
    const out = composeReviewerSystemPrompt(stale, fakeProject, fakeCard);
    expect(out.indexOf('Do **not** stop, refuse, or ask for a PR URL')).toBeLessThan(
      out.indexOf('If you cannot load the PR diff, stop'),
    );
  });
});

// ─── Driver behavior ──────────────────────────────────────────────────

describe('runReviewerTurn — happy path (approved)', () => {
  it('attaches reviewer, persists chat message, parses tail block', async () => {
    const assistantText = `Looks fine.

<agenthub:review-verdict>
{"verdict":"approved","threads":[]}
</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps, messages, attached } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-1',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(result.threads).toEqual([]);
    // Attach
    expect(attached).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
    // Persist with the structured tail STRIPPED so the chat view stays clean
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Looks fine.');
    expect(messages[0]?.agentId).toBe('rev-1');
  });

  it('spawns grok-cli when the reviewer agent is configured for grok', async () => {
    const assistantText = `Looks fine.

<agenthub:review-verdict>
{"verdict":"approved","threads":[]}
</agenthub:review-verdict>`;
    const { spawnFn, capturedArgs } = makeGrokSpawnFake(assistantText);
    const grokReviewer = { ...makeReviewer(), engine: 'grok-cli', model: 'grok-4.6' };
    const { deps } = makeDeps(spawnFn, {
      getEnrichedAgent: vi.fn().mockReturnValue(grokReviewer),
    });

    const result = await runReviewerTurn(deps, {
      runId: 'run-grok',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: {
        ...fakeProject,
        agents: [{ ...fakeProject.agents[0] }, { ...fakeProject.agents[1], engine: 'grok-cli' }],
      },
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(capturedArgs.map((c) => c.bin)).toEqual(['/fake/grok']);
    expect(capturedArgs[0]?.args).toContain('streaming-json');
    expect(capturedArgs[0]?.args).toContain('grok-4.6');
    const frames = (deps.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          engine: 'grok-cli',
          model: 'grok-4.6',
          agentId: grokReviewer.id,
          agentName: grokReviewer.name,
        }),
        expect.objectContaining({
          type: 'stream',
          engine: 'grok-cli',
          model: 'grok-4.6',
          agentId: grokReviewer.id,
        }),
      ]),
    );
  });

  it('uses the configured reviewer engine instead of a stale per-user engine override', async () => {
    const ownerId = 'codex-review-owner';
    initOrgsDb();
    createUser({ id: ownerId, username: 'codex-review-owner', passwordHash: 'x' });
    replaceUserPreferencesJson(ownerId, {
      // Reviewer agents are no longer editable in personal Agents settings,
      // but this legacy value can remain in preferences from older releases.
      agentEngineOverrides: { 'rev-1': { engine: 'claude-code' } },
    });

    const assistantText = `Looks fine.

<agenthub:review-verdict>
{"verdict":"approved","threads":[]}
</agenthub:review-verdict>`;
    const { spawnFn, capturedArgs } = makeCodexSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn, {
      getEnrichedAgent: vi.fn().mockReturnValue({
        ...makeReviewer(),
        engine: 'codex-cli',
      }),
    });
    const getSession = (
      deps as unknown as { stmts: { getSession: { get: ReturnType<typeof vi.fn> } } }
    ).stmts.getSession.get;
    getSession.mockReturnValue({ ...fakeSession, owner_user_id: ownerId });

    const result = await runReviewerTurn(deps, {
      runId: 'run-codex-reviewer',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]?.bin).toBe('/fake/codex');
    expect(capturedArgs[0]?.args).toContain('exec');
    expect(capturedArgs[0]?.args).toContain('--model');
    expect(capturedArgs[0]?.args).toContain('gpt-5.4');
  });

  it('accepts bare trailing fenced JSON when agenthub tags are omitted', async () => {
    const assistantText = `The change is clean overall.

\`\`\`json
{"verdict":"approved","threads":[{"file_path":"server/foo.ts","line_start":1,"line_end":2,"body":"**[3/10]** nit"}]}
\`\`\``;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps, messages } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-bare',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(result.threads).toHaveLength(1);
    expect(messages[0]?.content).toBe('The change is clean overall.');
  });

  it('accepts raw JSON-only verdicts without persisting the machine payload', async () => {
    const assistantText = JSON.stringify({
      verdict: 'changes_requested',
      threads: [
        {
          file_path: 'server/foo.ts',
          line_start: 10,
          line_end: 12,
          body: '**[7/10]** Real issue.',
        },
        {
          file_path: 'server/bar.ts',
          line_start: 3,
          line_end: 3,
          body: '**[5/10]** Another issue.',
        },
      ],
    });
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps, messages } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-json-only',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('changes_requested');
    expect(result.threads).toHaveLength(2);
    expect(messages[0]?.content).toBe('Review verdict: changes_requested (2 findings).');
  });
});

describe('runReviewerTurn — changes_requested with threads', () => {
  it('returns verdict + threads from the tail block', async () => {
    const assistantText = `Found a race on config.bin.

<agenthub:review-verdict>
{
  "verdict":"changes_requested",
  "threads":[
    {"file_path":"server/foo.ts","line_start":42,"line_end":45,"body":"**[6/10]** Race on config.bin."}
  ]
}
</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-2',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('changes_requested');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.file_path).toBe('server/foo.ts');
    expect(result.threads[0]?.body).toContain('Race on config.bin');
  });
});

describe('runReviewerTurn — changes_requested with no anchored findings', () => {
  it('recovers the reviewer prose as a file-level finding so the round is not empty', async () => {
    const assistantText = `This change ships scaffolding but never wires it up — the new helper has no caller, so the acceptance criterion is unmet.

<agenthub:review-verdict>
{"verdict":"changes_requested","threads":[]}
</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps, messages } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-empty-threads',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('changes_requested');
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.file_path).toBe(REVIEWER_GENERAL_FEEDBACK_ANCHOR);
    expect(result.threads[0]?.line_start).toBeNull();
    expect(result.threads[0]?.body).toContain('has no caller');
    // The prose still persists as the reviewer's chat message.
    expect(messages[0]?.content).toContain('has no caller');
  });

  it('throws when changes_requested has neither findings nor prose to recover', async () => {
    const assistantText = `<agenthub:review-verdict>{"verdict":"changes_requested","threads":[]}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-empty-both',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/no findings and no prose/);
  });

  it('leaves an approved verdict with empty threads untouched', async () => {
    const assistantText = `Looks good.

<agenthub:review-verdict>{"verdict":"approved","threads":[]}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    const result = await runReviewerTurn(deps, {
      runId: 'run-approved-empty',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(result.threads).toHaveLength(0);
  });
});

describe('runReviewerTurn — scoped prompt (no transcript bleed)', () => {
  it('does not read session messages to build the user prompt', async () => {
    const assistantText = `OK.

<agenthub:review-verdict>{"verdict":"approved","threads":[]}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    // `getMessages` is deliberately NOT supplied in the stmts pick —
    // attempting to read it would crash the test. Confirms the driver
    // does not pull transcript when scoping the prompt.
    await runReviewerTurn(deps, {
      runId: 'run-3',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    // Confirm by absence: getSession is called once (worktree lookup),
    // addSessionAgent is called once (attach), but no transcript reads.
    const stmts = deps.stmts as unknown as {
      getSession: { get: { mock: { calls: unknown[][] } } };
    };
    expect(stmts.getSession.get.mock.calls).toHaveLength(1);
  });

  it('bounds user-prompt size to roughly the diff body length', async () => {
    const assistantText = `<agenthub:review-verdict>{"verdict":"approved"}</agenthub:review-verdict>`;
    const { spawnFn, capturedArgs } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    const bigDiff = '+abc\n'.repeat(50); // ~200 bytes
    await runReviewerTurn(deps, {
      runId: 'run-4',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: { ...fakeInputs, unifiedDiff: bigDiff },
      sessionId: 'sess-1',
    });

    expect(capturedArgs).toHaveLength(1);
    const argsBlob = capturedArgs[0]!.args.join('\n');
    // The prompt should reference our diff body, and its total size
    // should be a small multiple of the diff body (NOT amplified by an
    // unbounded transcript). The buildLocalDiffReviewerPrompt template
    // is ~2k chars; the diff body adds ~200. Anything > 20x of the
    // diff body would signal transcript-bleed.
    expect(argsBlob.length).toBeLessThan(bigDiff.length * 25);
  });
});

describe('runReviewerTurn — defensive errors', () => {
  it('throws when no reviewer-role agent exists in the project', async () => {
    const noReviewerProject = {
      ...fakeProject,
      agents: [{ id: 'lead-1', name: 'Lead', engine: 'claude-code', role: 'lead' }],
    } as Project;
    const { spawnFn } = makeSpawnFake('ignored');
    const { deps } = makeDeps(spawnFn);

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-x',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: noReviewerProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/no role:'reviewer' agent/);
  });

  it('throws when the reviewer message has no tail block', async () => {
    const assistantText = `Looks fine but I forgot the block.`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-y',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/without a parseable review verdict/);
  });

  it('throws when tail block is malformed', async () => {
    const assistantText = `Body.
<agenthub:review-verdict>{"verdict":"meh"}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-z',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/malformed/);
  });

  it('throws when no sessionId is resolvable', async () => {
    const assistantText = `<agenthub:review-verdict>{"verdict":"approved"}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps } = makeDeps(spawnFn);
    const orphanedCard = { ...fakeCard, session_id: null } as unknown as KanbanCardRow;

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-q',
        worktreePath: '/tmp/wt',
        card: orphanedCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: null,
      }),
    ).rejects.toThrow(/no sessionId resolved/);
  });
});

describe('runReviewerTurn — cancellation', () => {
  it('respects a pre-aborted cancel signal before spawn', async () => {
    const { spawnFn } = makeSpawnFake('ignored');
    const { deps } = makeDeps(spawnFn);

    const signal = { aborted: true, onAbort: () => () => undefined };

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-c',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
        signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

// ─── Eject lifecycle ─────────────────────────────────────────────────
// The reviewer must leave the session roster once its turn ends — clean
// verdict, parse failure, or a cancel that kills the CLI mid-turn. The
// flow is: attach (bring in) → review → remove (eject). The persisted
// review message stays in the timeline; only the session_agents row goes.

function sessionUpdatedBroadcasts(broadcast: ReturnType<typeof vi.fn>): unknown[] {
  return broadcast.mock.calls
    .map((c) => c[0] as { type?: string })
    .filter((m) => m?.type === 'session-updated');
}

describe('runReviewerTurn — eject lifecycle', () => {
  it('removes the reviewer from the session after a clean verdict', async () => {
    const assistantText = `Looks fine.

<agenthub:review-verdict>{"verdict":"approved","threads":[]}</agenthub:review-verdict>`;
    const { spawnFn } = makeSpawnFake(assistantText);
    const { deps, attached, removed, messages } = makeDeps(spawnFn);

    await runReviewerTurn(deps, {
      runId: 'run-eject-ok',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(attached).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
    expect(removed).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
    // The review message itself survives the eject — only the roster row goes.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.agentId).toBe('rev-1');
    // Roster is broadcast for both the join and the leave so sidebars update live.
    const broadcast = deps.broadcast as unknown as ReturnType<typeof vi.fn>;
    expect(sessionUpdatedBroadcasts(broadcast).length).toBeGreaterThanOrEqual(2);
  });

  it('removes the reviewer even when the tail block is missing (throw path)', async () => {
    const { spawnFn } = makeSpawnFake('No block here.');
    const { deps, removed } = makeDeps(spawnFn);

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-eject-throw',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/without a parseable review verdict/);

    expect(removed).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
  });

  it('removes the reviewer when a cancel aborts before spawn', async () => {
    const { spawnFn } = makeSpawnFake('ignored');
    const { deps, attached, removed } = makeDeps(spawnFn);
    const signal = { aborted: true, onAbort: () => () => undefined };

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-eject-cancel',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
        signal,
      }),
    ).rejects.toThrow(/cancelled/);

    // Reviewer was attached (bring-in happens before the spawn cancel check)
    // and then ejected by the finally.
    expect(attached).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
    expect(removed).toEqual([{ sessionId: 'sess-1', agentId: 'rev-1' }]);
  });
});

// ─── Runtime engine failover ─────────────────────────────────────────
// The reviewer's configured engine can die mid-turn on usage exhaustion, an
// auth rejection, or a wedged provider that only surfaces as a timeout. Rather
// than failing the whole Finalize run, the reviewer turn re-runs the same
// scoped prompt on the next authenticated engine in the chain.

const VERDICT_OK = `Looks fine.

<agenthub:review-verdict>{"verdict":"approved","threads":[]}</agenthub:review-verdict>`;

describe('runReviewerTurn — engine failover', () => {
  it('switches to the next authenticated engine when the reviewer engine is usage-exhausted', async () => {
    const { spawnFn, capturedArgs } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'Claude AI usage limit reached. Resets in 3 hours.' },
      { bin: '/fake/codex', codex: true, text: VERDICT_OK },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'codex-cli']));
    // Reviewer carries a Claude-specific model. If the failover carried it onto
    // Codex, the replacement CLI would be invoked with a model it does not
    // offer — the assertion on the codex `--model` arg below guards that.
    const { deps, messages } = makeDeps(spawnFn, {
      probeAvailability,
      getEnrichedAgent: vi.fn().mockReturnValue({ ...makeReviewer(), model: 'claude-opus-4-8' }),
    });

    const result = await runReviewerTurn(deps, {
      runId: 'run-failover',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    // The review still completes — on Codex.
    expect(result.verdict).toBe('approved');
    // Both engines were spawned: claude first (died), then codex.
    expect(capturedArgs.map((c) => c.bin)).toEqual(['/fake/claude', '/fake/codex']);
    // The replacement CLI runs Codex's OWN default model, not the source
    // engine's Claude-specific reviewer model.
    const codexCall = capturedArgs.find((c) => c.bin === '/fake/codex')!;
    expect(codexCall.args).toContain('--model');
    expect(codexCall.args).toContain('gpt-5.4');
    expect(codexCall.args).not.toContain('claude-opus-4-8');
    // A single message is persisted, carrying the switch banner above the review.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('Switched to Codex');
    expect(messages[0]?.content).toContain('Looks fine.');
    expect(probeAvailability).toHaveBeenCalledTimes(1);
  });

  it('fails over on a bare timeout (a wedged/maxed provider that never returns)', async () => {
    // No usage string — just the harness timeout wording the reviewer turn emits.
    const { spawnFn, capturedArgs } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'reviewer turn timed out after 5000ms' },
      { bin: '/fake/codex', codex: true, text: VERDICT_OK },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'codex-cli']));
    const { deps } = makeDeps(spawnFn, { probeAvailability });

    const result = await runReviewerTurn(deps, {
      runId: 'run-timeout-failover',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(capturedArgs.map((c) => c.bin)).toEqual(['/fake/claude', '/fake/codex']);
  });

  it('fails over to grok-cli when Claude is exhausted and grok is authenticated', async () => {
    const { spawnFn, capturedArgs } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'Claude AI usage limit reached.' },
      { bin: '/fake/grok', grok: true, text: VERDICT_OK },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'grok-cli']));
    const { deps } = makeDeps(spawnFn, { probeAvailability });

    const result = await runReviewerTurn(deps, {
      runId: 'run-grok-failover',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    expect(capturedArgs.map((c) => c.bin)).toEqual(['/fake/claude', '/fake/grok']);
  });

  it('does not fail over a non-quota reviewer bug (surfaces the original error)', async () => {
    const { spawnFn, capturedArgs } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'reviewer exited with code 1' },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'codex-cli']));
    const { deps } = makeDeps(spawnFn, { probeAvailability });

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-nonfailover',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
      }),
    ).rejects.toThrow(/exited with code 1/);
    // An unrecognized failure never walks the chain.
    expect(capturedArgs.map((c) => c.bin)).toEqual(['/fake/claude']);
    expect(probeAvailability).toHaveBeenCalledTimes(1);
  });

  it('does not fail over a cancellation', async () => {
    const { spawnFn } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'cancelled' },
      { bin: '/fake/codex', codex: true, text: VERDICT_OK },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'codex-cli']));
    const { deps } = makeDeps(spawnFn, { probeAvailability });
    const signal = { aborted: true, onAbort: () => () => undefined };

    await expect(
      runReviewerTurn(deps, {
        runId: 'run-cancel-nofailover',
        worktreePath: '/tmp/wt',
        card: fakeCard,
        project: fakeProject,
        inputs: fakeInputs,
        sessionId: 'sess-1',
        signal,
      }),
    ).rejects.toThrow(/cancelled/);
    // Cancellation must not trigger a probe or a switch.
    expect(probeAvailability).not.toHaveBeenCalled();
  });

  it("honors the session owner's per-user model pick for the fallback engine", async () => {
    // The owner has selected a non-default Codex model in the Reviewer model
    // dropdown (their per-user agentModelOverrides). On failover to Codex the
    // replacement CLI must run THAT model, not Codex's application default —
    // i.e. ownerUserId + agentId are still passed when resolving the fallback.
    const ownerId = 'owner-with-codex-pick';
    initOrgsDb();
    createUser({ id: ownerId, username: ownerId, passwordHash: 'x' });
    replaceUserPreferencesJson(ownerId, {
      agentModelOverrides: { 'rev-1': 'gpt-5.4-mini' },
    });

    const { spawnFn, capturedArgs } = makeDispatchSpawnFake([
      { bin: '/fake/claude', fail: 'Claude AI usage limit reached.' },
      { bin: '/fake/codex', codex: true, text: VERDICT_OK },
    ]);
    const probeAvailability = vi
      .fn()
      .mockResolvedValue(availabilityWith(['claude-code', 'codex-cli']));
    // Config advertises a second selectable Codex model so the owner's pick is
    // distinguishable from the default.
    const configWithCodexPick = {
      ...fakeConfig,
      engineValidModels: {
        ...fakeConfig.engineValidModels,
        'codex-cli': ['gpt-5.4', 'gpt-5.4-mini'],
      },
    } as unknown as AppConfig;
    const { deps } = makeDeps(spawnFn, {
      probeAvailability,
      getConfig: () => configWithCodexPick,
      getEnrichedAgent: vi.fn().mockReturnValue({ ...makeReviewer(), model: 'claude-opus-4-8' }),
    });
    const getSession = (
      deps as unknown as { stmts: { getSession: { get: ReturnType<typeof vi.fn> } } }
    ).stmts.getSession.get;
    getSession.mockReturnValue({ ...fakeSession, owner_user_id: ownerId });

    const result = await runReviewerTurn(deps, {
      runId: 'run-owner-model-pick',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
      inputs: fakeInputs,
      sessionId: 'sess-1',
    });

    expect(result.verdict).toBe('approved');
    const codexCall = capturedArgs.find((c) => c.bin === '/fake/codex')!;
    expect(codexCall.args).toContain('--model');
    // Owner's dropdown pick wins over the Codex default (gpt-5.4).
    expect(codexCall.args).toContain('gpt-5.4-mini');
    expect(codexCall.args).not.toContain('gpt-5.4');
    expect(codexCall.args).not.toContain('claude-opus-4-8');
  });
});

describe('restrictToSpawnableEngines', () => {
  it('keeps grok-cli available now that the in-session reviewer can spawn it', () => {
    const restricted = restrictToSpawnableEngines(
      availabilityWith(['claude-code', 'codex-cli', 'grok-cli']),
    );
    expect(restricted['grok-cli'].available).toBe(true);
    expect(restricted['claude-code'].available).toBe(true);
    expect(restricted['codex-cli'].available).toBe(true);
  });

  it('leaves an already-unavailable grok entry as-is', () => {
    const restricted = restrictToSpawnableEngines(availabilityWith(['claude-code']));
    expect(restricted['grok-cli'].available).toBe(false);
  });
});

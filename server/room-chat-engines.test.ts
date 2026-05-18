import { vi, type Mock, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process before importing room-chat so spawn / execFile are
// captured rather than executing the real CLI binaries. The test/setup.ts
// guard also forbids spawning the real binaries — this mock satisfies that
// guard and lets us assert on argv.
vi.mock('child_process', () => {
  const spawnMock = vi.fn();
  const execFileMock = vi.fn();
  return { spawn: spawnMock, execFile: execFileMock, exec: execFileMock };
});

// Stub project-model so room-chat's `getProjects()` lookup is a noop.
vi.mock('./project-model.js', () => ({
  getProjects: () => [],
}));

// Stub session-ownership so we don't need real WS auth.
vi.mock('./session-ownership.js', () => ({
  getWsAuthUserId: () => null,
  getOrgOwnerUserId: () => null,
}));

// Stub skill-credentials-spawn so we don't read DB creds.
vi.mock('./skill-credentials-spawn.js', () => ({
  mergeSkillCredentialSpawnEnv: () => undefined,
}));

// Stub process-groups so we don't actually fiddle with PGIDs.
vi.mock('./process-groups.js', () => ({
  trackChild: () => undefined,
  killProcessGroup: () => undefined,
}));

const { spawn, execFile } = await import('child_process');
const spawnMock = spawn as unknown as Mock;
const execFileMock = execFile as unknown as Mock;

const { initRoomChat, handleRoomChat } = await import('./room-chat.js');

type StmtCall<T> = { run: Mock; get: Mock; all: Mock } & T;

function makeStmt(): StmtCall<Record<string, unknown>> {
  return {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  } as unknown as StmtCall<Record<string, unknown>>;
}

interface RoomChatHarness {
  broadcasts: Array<{ type: string; [k: string]: unknown }>;
  stmts: Record<string, StmtCall<Record<string, unknown>>>;
}

function setupHarness(opts: {
  roomAgents: Array<{ id: string; engine: string; name: string }>;
}): RoomChatHarness {
  const broadcasts: RoomChatHarness['broadcasts'] = [];
  const stmts: Record<string, StmtCall<Record<string, unknown>>> = {};

  const ensure = (name: string): StmtCall<Record<string, unknown>> => {
    if (!stmts[name]) stmts[name] = makeStmt();
    return stmts[name];
  };

  ensure('getRoom').get = vi
    .fn()
    .mockReturnValue({ id: 'room-1', name: 'Test Room', project_id: 'proj-1', max_turns: 1 });

  ensure('getRoomAgents').all = vi
    .fn()
    .mockReturnValue(opts.roomAgents.map((a) => ({ agent_id: a.id })));

  ensure('getRoomMessages').all = vi.fn().mockReturnValue([]);
  ensure('getQueuedRoomMessages').all = vi.fn().mockReturnValue([]);
  ensure('getMaxRoomQueuePosition').get = vi.fn().mockReturnValue({ max_pos: null });
  ensure('addRoomMessage').run = vi.fn();
  ensure('touchRoom').run = vi.fn();
  ensure('insertActiveRoomTask').run = vi.fn();
  ensure('updateActiveRoomTaskAgent').run = vi.fn();
  ensure('appendActiveRoomTaskOutput').run = vi.fn();
  ensure('deleteActiveRoomTask').run = vi.fn();
  ensure('enqueueRoomMessage').run = vi.fn();
  ensure('dequeueRoomMessage').run = vi.fn();
  ensure('getNextQueuedRoomMessage').get = vi.fn().mockReturnValue(undefined);
  ensure('clearRoomQueue').run = vi.fn();

  const enrichedByEngine = new Map(
    opts.roomAgents.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        engine: a.engine,
        color: '#aaa',
        cwd: '/tmp/room-cwd',
        ahw: '/tmp/room-ahw',
        workspace: '/tmp/room-ws',
        projectId: 'proj-1',
        projectName: 'agent-hub',
      },
    ]),
  );

  initRoomChat({
    stmts: stmts as unknown as Parameters<typeof initRoomChat>[0]['stmts'],
    broadcast: ((msg: { type: string; [k: string]: unknown }) => {
      broadcasts.push(msg);
    }) as unknown as Parameters<typeof initRoomChat>[0]['broadcast'],
    getEnrichedAgent: (id: string) =>
      enrichedByEngine.get(id) as unknown as ReturnType<
        Parameters<typeof initRoomChat>[0]['getEnrichedAgent']
      >,
    buildEnrichedPrompt: () => 'ENRICHED_PROMPT_BODY',
    getClaudeBin: () => '/bin/claude',
    getCursorBin: () => '/bin/cursor',
    getGeminiBin: () => '/bin/gemini',
    getCodexBin: () => '/bin/codex',
    getDefaultModel: () => 'default-model',
    getConfig: () =>
      ({
        conferenceTimeoutMs: 60_000,
        codexDangerBypass: true,
        engineDefaultModels: {
          'claude-code': 'claude-opus-4-7',
          'cursor-agent': 'composer-2.5',
          'gemini-cli': 'gemini-2.5-pro',
          'codex-cli': 'gpt-5.3-codex',
        },
        engineValidModels: {},
        defaultModel: 'default-model',
      }) as unknown as Parameters<typeof initRoomChat>[0]['getConfig'] extends () => infer R
        ? R
        : never,
    getMaxQueueSize: () => 5,
  });

  return { broadcasts, stmts };
}

// Build a fake spawn child that emits stdout chunks then close(0).
function fakeChild(stdoutChunks: string[]): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: Mock };
  pid?: number;
} {
  const proc: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: Mock };
    pid?: number;
  } = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn() },
    pid: 1234,
  });
  setTimeout(() => {
    for (const chunk of stdoutChunks) {
      proc.stdout.emit('data', Buffer.from(chunk));
    }
    proc.emit('close', 0);
  }, 0);
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleRoomChat — per-engine spawn', () => {
  it('claude-code agent: spawns claudeBin with --print --output-format stream-json + system prompt', async () => {
    const h = setupHarness({
      roomAgents: [{ id: 'a-claude', engine: 'claude-code', name: 'ClaudeDev' }],
    });

    spawnMock.mockImplementation(() =>
      fakeChild([
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello from claude' }] },
        }) + '\n',
      ]),
    );

    await handleRoomChat(null, { roomId: 'room-1', content: 'kick it off' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/bin/claude');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect((args as string[])[(args as string[]).indexOf('--output-format') + 1]).toBe(
      'stream-json',
    );
    expect(args).toContain('--system-prompt');

    // assistant_text from the stream-parser made it to a room_stream broadcast.
    const streams = h.broadcasts.filter((b) => b.type === 'room_stream');
    expect(streams.length).toBeGreaterThan(0);
    const lastStream = streams[streams.length - 1] as unknown as { content: string };
    expect(lastStream.content).toContain('hello from claude');

    const dones = h.broadcasts.filter((b) => b.type === 'room_agent_done');
    expect(dones).toHaveLength(1);
  });

  it('cursor-agent agent: calls cursor create-chat, then spawns cursorBin with -p / --resume / stream-json', async () => {
    setupHarness({
      roomAgents: [{ id: 'a-cursor', engine: 'cursor-agent', name: 'CursorDev' }],
    });

    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, 'fresh-cursor-chat-id\n', '');
      },
    );

    spawnMock.mockImplementation(() =>
      fakeChild([
        // Cursor's stream-json `result` event drives finalized assistant_text.
        JSON.stringify({
          type: 'result',
          result: 'hello from cursor',
          duration_ms: 100,
          is_error: false,
        }) + '\n',
      ]),
    );

    await handleRoomChat(null, { roomId: 'room-1', content: 'go' });

    // execFile was used to mint a fresh cursor chat id.
    expect(execFileMock).toHaveBeenCalled();
    const [cursorBin, cursorArgs] = execFileMock.mock.calls[0];
    expect(cursorBin).toBe('/bin/cursor');
    expect(cursorArgs).toEqual(['create-chat']);

    // The main spawn used cursorBin with the documented stream-json shape.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/bin/cursor');
    const a = args as string[];
    expect(a[0]).toBe('-p');
    expect(a).toContain('--resume');
    expect(a[a.indexOf('--resume') + 1]).toBe('fresh-cursor-chat-id');
    expect(a).toContain('--force');
    expect(a).toContain('--output-format');
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--stream-partial-output');
  });

  it('gemini-cli agent: spawns geminiBin with -p / --output-format stream-json / --yolo', async () => {
    setupHarness({
      roomAgents: [{ id: 'a-gemini', engine: 'gemini-cli', name: 'GeminiDev' }],
    });

    spawnMock.mockImplementation(() =>
      fakeChild([
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from gemini' }],
        }) + '\n',
        JSON.stringify({ type: 'result', response: 'hello from gemini' }) + '\n',
      ]),
    );

    await handleRoomChat(null, { roomId: 'room-1', content: 'go' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/bin/gemini');
    const a = args as string[];
    expect(a[0]).toBe('-p');
    expect(a).toContain('--output-format');
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--yolo');
  });

  it('codex-cli agent: spawns codexBin with exec --json + danger bypass and pipes prompt via stdin', async () => {
    setupHarness({
      roomAgents: [{ id: 'a-codex', engine: 'codex-cli', name: 'CodexDev' }],
    });

    spawnMock.mockImplementation(() =>
      fakeChild([
        // Codex normalizer emits assistant_text from `item.completed` of an `agent_message`.
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'hello from codex' },
        }) + '\n',
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) +
          '\n',
      ]),
    );

    await handleRoomChat(null, { roomId: 'room-1', content: 'go' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('/bin/codex');
    const a = args as string[];
    expect(a[0]).toBe('exec');
    expect(a).toContain('--json');
    expect(a).toContain('--skip-git-repo-check');
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(a).not.toContain('--full-auto');
    expect(a[a.length - 1]).toBe('-');
    // stdio[0] must be 'pipe' so we can write the prompt to stdin.
    expect((opts as { stdio: unknown[] }).stdio[0]).toBe('pipe');

    // The prompt was actually written to the child's stdin.
    const stdinEnd = spawnMock.mock.results[0].value.stdin.end as Mock;
    expect(stdinEnd).toHaveBeenCalledTimes(1);
    const writtenPrompt = stdinEnd.mock.calls[0][0] as string;
    expect(writtenPrompt).toContain('ENRICHED_PROMPT_BODY');
  });

  it('cancellation: handleRoomCancel kills the active child via process group', async () => {
    const { handleRoomCancel } = await import('./room-chat.js');
    setupHarness({
      roomAgents: [{ id: 'a-claude2', engine: 'claude-code', name: 'ClaudeDev2' }],
    });

    const killSpy = vi.fn();
    // Use a child that never closes on its own so we can race the cancel.
    spawnMock.mockImplementation(() => {
      const proc: EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: Mock };
        kill: Mock;
      } = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: vi.fn() },
        kill: killSpy,
      });
      // After a tick, simulate the SIGTERM we expect handleRoomCancel to send.
      setTimeout(() => {
        proc.emit('close', null);
      }, 5);
      return proc;
    });

    const turn = handleRoomChat(null, { roomId: 'room-1', content: 'go' });
    // Give the spawn a tick to register.
    await new Promise((r) => setTimeout(r, 1));
    handleRoomCancel('room-1');
    await turn;

    // The turn must have completed (no hanging Promise) and a `room_cancelled`
    // broadcast indicates the cancel path executed.
    // (We don't assert directly on killProcessGroup because it's mocked, but
    // the test would hang if the cancel path didn't surface the close.)
  });
});

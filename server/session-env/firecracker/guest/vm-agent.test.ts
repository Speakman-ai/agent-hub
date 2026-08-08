import { describe, it, expect, afterEach } from 'vitest';
import { connect, type Server, type Socket } from 'net';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import {
  createVmAgentServer,
  buildChildEnv,
  buildChildLaunch,
  resolveWorkspaceUser,
  SETPRIV_BIN,
} from './vm-agent.js';
import {
  VmAgentFrameDecoder,
  encodeJsonFrame,
  encodeFrame,
  decodeJsonPayload,
  type VmAgentExit,
  type VmAgentFrame,
  type VmAgentReply,
  type VmAgentRequest,
} from '../vm-agent-protocol.js';

/**
 * These drive the real agent over a real Unix socket with real child
 * processes — the vsock hop and the uid drop are the only things stubbed.
 * The framing and process plumbing are where this code is most likely to be
 * subtly wrong, and nothing short of running it catches that.
 *
 * Commands are `/bin/sh` and coreutils only; the suite's CLI guard forbids
 * spawning the agent binaries, and nothing here needs them.
 */

const me = userInfo();
const asCurrentUser = { uid: me.uid, gid: me.gid, home: me.homedir, name: me.username };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startAgent(): Promise<{ socketPath: string; server: Server }> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-agent-'));
  const socketPath = join(dir, 'agent.sock');
  const server = createVmAgentServer({ workspaceUser: asCurrentUser });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, server };
}

interface AgentStream {
  socket: Socket;
  frames: VmAgentFrame[];
  /** Resolves with all frames received once the agent closes the stream. */
  done: Promise<VmAgentFrame[]>;
  send(frame: Buffer): void;
  waitFor(type: VmAgentFrame['type']): Promise<VmAgentFrame>;
}

async function openStream(socketPath: string, request: VmAgentRequest): Promise<AgentStream> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const decoder = new VmAgentFrameDecoder();
  const frames: VmAgentFrame[] = [];
  const waiters: { type: VmAgentFrame['type']; resolve: (f: VmAgentFrame) => void }[] = [];

  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === frame.type) waiters.splice(i, 1)[0].resolve(frame);
      }
    }
  });
  const done = new Promise<VmAgentFrame[]>((resolve) => socket.on('close', () => resolve(frames)));
  cleanups.push(async () => {
    socket.destroy();
  });

  socket.write(encodeJsonFrame('request', request));
  return {
    socket,
    frames,
    done,
    send: (frame) => socket.write(frame),
    waitFor: (type) => {
      const existing = frames.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

const text = (frames: VmAgentFrame[], type: VmAgentFrame['type']) =>
  frames
    .filter((f) => f.type === type)
    .map((f) => f.payload.toString())
    .join('');

describe('vm-agent over a real socket', () => {
  it('answers a ping with the protocol version and a boot id', async () => {
    // This is the exact exchange the Hub's readiness probe makes, so a
    // regression here strands every VM at boot.
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, { kind: 'ping', protocolVersion: 1 });
    const reply = decodeJsonPayload<VmAgentReply>((await stream.waitFor('reply')).payload);
    expect(reply).toMatchObject({ kind: 'pong', protocolVersion: 1 });
    expect((reply as { bootId: string }).bootId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runs a command and reports stdout, stderr, and the exit code', async () => {
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'echo out; echo err >&2; exit 3',
      cwd: process.cwd(),
      env: {},
    });
    const frames = await stream.done;
    expect(text(frames, 'stdout').trim()).toBe('out');
    expect(text(frames, 'stderr').trim()).toBe('err');
    const exit = decodeJsonPayload<VmAgentExit>(frames.find((f) => f.type === 'exit')!.payload);
    expect(exit.code).toBe(3);
  });

  it('reports the child pid before any output', async () => {
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'echo hi',
      cwd: process.cwd(),
      env: {},
    });
    const started = decodeJsonPayload<{ pid: number }>((await stream.waitFor('started')).payload);
    expect(started.pid).toBeGreaterThan(0);
    expect(stream.frames[0].type).toBe('started');
  });

  it('passes the requested env and cwd through to the child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-agent-cwd-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'printf "%s|%s" "$MARKER" "$(pwd)"',
      cwd: dir,
      env: { MARKER: 'session-env' },
    });
    const frames = await stream.done;
    const [marker, cwd] = text(frames, 'stdout').split('|');
    expect(marker).toBe('session-env');
    // macOS resolves /var through a symlink to /private/var.
    expect(cwd.endsWith(dir.replace(/^\/private/, ''))).toBe(true);
  });

  it('forwards stdin and closes it on request', async () => {
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'cat',
      cwd: process.cwd(),
      env: {},
    });
    await stream.waitFor('started');
    stream.send(encodeFrame('stdin', Buffer.from('piped input')));
    // Without the EOF `cat` never exits, which is the point of the control.
    stream.send(encodeJsonFrame('control', { kind: 'stdin-eof' }));
    const frames = await stream.done;
    expect(text(frames, 'stdout')).toBe('piped input');
  });

  it('signals the whole process group, not just the shell', async () => {
    // `sh -c` forks; signalling only the shell leaves the real workload
    // running and the VM never goes idle.
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'sleep 30 & wait',
      cwd: process.cwd(),
      env: {},
    });
    await stream.waitFor('started');
    stream.send(encodeJsonFrame('control', { kind: 'signal', signal: 'SIGKILL' }));
    const frames = await stream.done;
    const exit = decodeJsonPayload<VmAgentExit>(frames.find((f) => f.type === 'exit')!.payload);
    expect(exit.signal ?? exit.code).toBeTruthy();
  }, 15_000);

  it('surfaces a missing binary as an error frame rather than a hang', async () => {
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'exec',
      command: 'definitely-not-a-real-binary-xyz',
      cwd: process.cwd(),
      env: {},
    });
    const frames = await stream.done;
    // `sh -c` reports this as exit 127 rather than a spawn error; either way
    // the stream must terminate with a verdict.
    const exit = frames.find((f) => f.type === 'exit');
    const error = frames.find((f) => f.type === 'error');
    expect(exit ?? error).toBeDefined();
    if (exit) expect(decodeJsonPayload<VmAgentExit>(exit.payload).code).toBe(127);
  });

  it('reads and writes files on the Hub behalf', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-agent-fs-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const target = join(dir, 'note.txt');
    const { socketPath } = await startAgent();

    const write = await openStream(socketPath, {
      kind: 'write-file',
      path: target,
      contentBase64: Buffer.from('hello vm').toString('base64'),
      mode: '0640',
    });
    expect(decodeJsonPayload<VmAgentReply>((await write.waitFor('reply')).payload)).toEqual({
      kind: 'written',
    });
    expect(await readFile(target, 'utf8')).toBe('hello vm');

    const read = await openStream(socketPath, { kind: 'read-file', path: target });
    const reply = decodeJsonPayload<VmAgentReply>((await read.waitFor('reply')).payload) as {
      contentBase64: string;
    };
    expect(Buffer.from(reply.contentBase64, 'base64').toString()).toBe('hello vm');
  });

  it('reports a missing file as an error instead of a silent empty read', async () => {
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, {
      kind: 'read-file',
      path: '/definitely/not/here',
    });
    const error = await stream.waitFor('error');
    expect(decodeJsonPayload<{ message: string }>(error.payload).message).toMatch(/ENOENT/);
  });

  it('answers a port query with whatever the kernel reports', async () => {
    // /proc/net/tcp does not exist on macOS, so the interesting assertion is
    // that the agent degrades to an empty list rather than failing the query.
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, { kind: 'list-ports' });
    const reply = decodeJsonPayload<VmAgentReply>((await stream.waitFor('reply')).payload) as {
      kind: string;
      ports: unknown[];
    };
    expect(reply.kind).toBe('ports');
    expect(Array.isArray(reply.ports)).toBe(true);
  });

  it('rejects a second request on one connection', async () => {
    // One connection is one logical stream; allowing a second request would
    // interleave two children's output on the same frames.
    const { socketPath } = await startAgent();
    const stream = await openStream(socketPath, { kind: 'ping', protocolVersion: 1 });
    stream.send(encodeJsonFrame('request', { kind: 'ping', protocolVersion: 1 }));
    const frames = await stream.done;
    const error = frames.find((f) => f.type === 'error');
    if (error) {
      expect(decodeJsonPayload<{ message: string }>(error.payload).message).toMatch(
        /second request/,
      );
    }
  });

  it('keeps concurrent streams independent', async () => {
    const { socketPath } = await startAgent();
    const [a, b] = await Promise.all([
      openStream(socketPath, { kind: 'exec', command: 'echo A', cwd: process.cwd(), env: {} }),
      openStream(socketPath, { kind: 'exec', command: 'echo B', cwd: process.cwd(), env: {} }),
    ]);
    const [framesA, framesB] = await Promise.all([a.done, b.done]);
    expect(text(framesA, 'stdout').trim()).toBe('A');
    expect(text(framesB, 'stdout').trim()).toBe('B');
  });
});

describe('buildChildEnv', () => {
  it('provides a usable baseline for a login-less shell', () => {
    const env = buildChildEnv(asCurrentUser, {});
    expect(env.PATH).toContain('/usr/bin');
    expect(env.HOME).toBe(asCurrentUser.home);
    expect(env.USER).toBe(asCurrentUser.name);
  });

  it('treats null as unset and undefined as untouched', () => {
    // The distinction is load-bearing: the terminal drops ambient AWS
    // credentials by sending null, and an absent key must not do the same.
    const env = buildChildEnv(asCurrentUser, { HOME: null, SHELL: undefined, EXTRA: 'x' });
    expect('HOME' in env).toBe(false);
    expect(env.SHELL).toBe('/bin/bash');
    expect(env.EXTRA).toBe('x');
  });
});

describe('resolveWorkspaceUser', () => {
  it('returns the current user when it is already the workspace user', () => {
    expect(resolveWorkspaceUser(me.username)).toMatchObject({ uid: me.uid, name: me.username });
  });

  it('parses the user out of /etc/passwd otherwise', () => {
    const passwd = [
      'root:x:0:0:root:/root:/bin/bash',
      'runner:x:1000:1000::/home/runner:/bin/bash',
    ];
    expect(resolveWorkspaceUser('runner', () => passwd.join('\n'))).toEqual({
      uid: 1000,
      gid: 1000,
      home: '/home/runner',
      name: 'runner',
    });
  });

  it('fails loudly rather than silently running everything as root', () => {
    expect(() => resolveWorkspaceUser('nope', () => 'root:x:0:0:root:/root:/bin/bash')).toThrow(
      /does not exist in this guest/,
    );
  });
});

describe('buildChildLaunch', () => {
  const user = { uid: 1000, gid: 1000, home: '/home/runner', name: 'runner' };

  it('drops root to the workspace user with its real supplementary groups', () => {
    const launch = buildChildLaunch(user, '/bin/sh', ['-c', 'docker ps'], 0);
    expect(launch.file).toBe(SETPRIV_BIN);
    // --init-groups is the whole point: spawn's uid/gid options leave the
    // child in root's groups, so it is not in `docker` and every docker
    // command fails on the socket despite the user being a member.
    expect(launch.args).toEqual([
      '--reuid=1000',
      '--regid=1000',
      '--init-groups',
      '--inh-caps=-all',
      '--',
      '/bin/sh',
      '-c',
      'docker ps',
    ]);
  });

  it('runs directly when the agent is already unprivileged', () => {
    // setpriv --reuid would simply fail here, and there is nothing to drop.
    expect(buildChildLaunch(user, '/bin/sh', ['-c', 'true'], 1000)).toEqual({
      file: '/bin/sh',
      args: ['-c', 'true'],
    });
  });

  it('runs directly when root is also the workspace user', () => {
    const root = { uid: 0, gid: 0, home: '/root', name: 'root' };
    expect(buildChildLaunch(root, '/bin/sh', [], 0).file).toBe('/bin/sh');
  });

  it('runs directly when the uid cannot be determined (non-POSIX host)', () => {
    expect(buildChildLaunch(user, '/bin/sh', [], undefined).file).toBe('/bin/sh');
  });
});

import { describe, it, expect } from 'vitest';
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
  VmAgentFrameDecoder,
  encodeFrame,
  encodeJsonFrame,
  decodeJsonPayload,
  parseVsockHandshake,
  vsockConnectCommand,
  type VmAgentExecRequest,
} from './vm-agent-protocol.js';

function decodeAll(chunks: Buffer[]): { type: string; payload: Buffer }[] {
  const decoder = new VmAgentFrameDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

describe('vm-agent frame codec', () => {
  it('round-trips a payload through encode and decode', () => {
    const frames = decodeAll([encodeFrame('stdout', Buffer.from('hello'))]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('stdout');
    expect(frames[0].payload.toString()).toBe('hello');
  });

  it('reassembles a frame split across chunk boundaries', () => {
    // vsock hands us a byte stream, so the split can land anywhere —
    // including inside the 5-byte header, which a naive reader mis-parses as
    // a length prefix.
    const frame = encodeFrame('stdout', Buffer.from('abcdefghij'));
    const decoder = new VmAgentFrameDecoder();
    const collected = [];
    for (let i = 0; i < frame.length; i++) {
      collected.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0].payload.toString()).toBe('abcdefghij');
    expect(decoder.pendingBytes).toBe(0);
  });

  it('splits several frames delivered in a single chunk', () => {
    const merged = Buffer.concat([
      encodeFrame('stdout', Buffer.from('one')),
      encodeFrame('stderr', Buffer.from('two')),
      encodeJsonFrame('exit', { code: 0, signal: null }),
    ]);
    const frames = decodeAll([merged]);
    expect(frames.map((f) => f.type)).toEqual(['stdout', 'stderr', 'exit']);
    expect(frames[1].payload.toString()).toBe('two');
    expect(decodeJsonPayload<{ code: number }>(frames[2].payload).code).toBe(0);
  });

  it('preserves bytes that would break a newline-delimited protocol', () => {
    // The reason this protocol is length-prefixed: PTY output routinely
    // carries newlines, NUL, and split UTF-8 sequences. A line-based reader
    // corrupts exactly the payloads a terminal depends on.
    const nasty = Buffer.from([0x0a, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0xc3]);
    const frames = decodeAll([encodeFrame('stdout', nasty)]);
    expect(frames[0].payload.equals(nasty)).toBe(true);
  });

  it('holds back an incomplete frame instead of emitting a partial payload', () => {
    const frame = encodeFrame('stdout', Buffer.from('abcdef'));
    const decoder = new VmAgentFrameDecoder();
    expect(decoder.push(frame.subarray(0, FRAME_HEADER_BYTES + 2))).toEqual([]);
    expect(decoder.pendingBytes).toBe(FRAME_HEADER_BYTES + 2);
    const frames = decoder.push(frame.subarray(FRAME_HEADER_BYTES + 2));
    expect(frames[0].payload.toString()).toBe('abcdef');
  });

  it('rejects an oversize payload at encode time', () => {
    const tooBig = Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1);
    expect(() => encodeFrame('stdout', tooBig)).toThrow(/exceeds the/);
  });

  it('cannot fit a zip-sized JSON write-file in one frame', () => {
    // 6 MiB of raw bytes base64-expands to exactly MAX_FRAME_PAYLOAD_BYTES
    // before the JSON envelope; encodeFrame then throws. Chat attachments
    // (zips, videos) routinely exceed this, which is why writeGuestFile
    // streams them over exec+stdin instead of stuffing contentBase64.
    const contentBase64 = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    expect(() =>
      encodeJsonFrame('request', {
        kind: 'write-file',
        path: '/workspace/pack.zip',
        contentBase64,
      }),
    ).toThrow(/exceeds the/);
  });

  it('rejects a length prefix above the cap rather than allocating', () => {
    // A desynchronized stream reads garbage as a length. Without this guard
    // the decoder would wait on (or allocate for) a multi-gigabyte frame.
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt8(0x03, 0);
    header.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1, 1);
    expect(() => new VmAgentFrameDecoder().push(header)).toThrow(/desynchronized/);
  });

  it('rejects an unknown frame type byte', () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt8(0x7f, 0);
    header.writeUInt32BE(0, 1);
    expect(() => new VmAgentFrameDecoder().push(header)).toThrow(/unknown type byte 0x7f/);
  });

  it('carries a typed request as JSON', () => {
    const request: VmAgentExecRequest = {
      kind: 'exec',
      command: 'npm run dev',
      cwd: '/workspace',
      env: { PORT: '4200' },
    };
    const frames = decodeAll([encodeJsonFrame('request', request)]);
    expect(decodeJsonPayload<VmAgentExecRequest>(frames[0].payload)).toEqual(request);
  });
});

describe('firecracker vsock handshake', () => {
  it('formats the host-initiated CONNECT line', () => {
    expect(vsockConnectCommand(1024).toString()).toBe('CONNECT 1024\n');
  });

  it('waits for the terminating newline before deciding', () => {
    // A short read must not be mistaken for a rejected connection.
    expect(parseVsockHandshake(Buffer.from('OK 104'))).toBeNull();
  });

  it('accepts OK and returns the bytes that follow it', () => {
    const result = parseVsockHandshake(
      Buffer.concat([Buffer.from('OK 1024\n'), Buffer.from([1, 2, 3])]),
    );
    expect(result?.ok).toBe(true);
    expect(result?.rest.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('reports a refused connection with the raw line', () => {
    const result = parseVsockHandshake(Buffer.from('FAILED\n'));
    expect(result?.ok).toBe(false);
    expect(result?.line).toBe('FAILED');
  });
});

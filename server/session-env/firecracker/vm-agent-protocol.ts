/**
 * Wire protocol between the Hub and the agent running inside a session
 * microVM.
 *
 * Firecracker's device model is deliberately tiny: virtio-net, virtio-block,
 * virtio-vsock, balloon, rng. There is no virtio-fs and no 9p, and the VM has
 * no docker-exec equivalent — so every control operation the SessionEnv
 * contract needs (run a command, open a PTY, observe listening ports, read a
 * file) has to be carried over the one channel that exists: vsock.
 *
 * Framing is length-prefixed rather than newline-delimited because the same
 * channel carries PTY bytes, which are binary and routinely contain \n and
 * invalid UTF-8 mid-sequence. A JSON-lines protocol would corrupt exactly the
 * payloads a terminal cares about.
 *
 * Frame layout (big-endian, matching network order):
 *
 *   0        1                    5                     5 + len
 *   +--------+--------------------+---------------------+
 *   | type   | payload length u32 | payload             |
 *   +--------+--------------------+---------------------+
 *
 * One vsock connection carries exactly one logical stream (an exec, a PTY, or
 * a control request). Firecracker multiplexes connections for us, so the
 * protocol itself needs no stream ids — a design that keeps a stuck PTY from
 * blocking an unrelated exec's output.
 */

/**
 * Guest-side vsock port the agent listens on. Chosen above the privileged
 * range and fixed: the host has no way to discover a dynamic port before the
 * first connection succeeds.
 */
export const VM_AGENT_VSOCK_PORT = 1024;

/** Bumped only on breaking frame/JSON changes; checked during the handshake. */
export const VM_AGENT_PROTOCOL_VERSION = 2;

/**
 * Hard cap on a single frame. Guards the guest against a host bug (and vice
 * versa) turning a corrupt length prefix into an unbounded allocation. Output
 * chunks are far smaller; file reads above this stream as multiple frames.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Bytes per `read-file` range. base64 costs 4/3, so this leaves room for the
 * JSON envelope under {@link MAX_FRAME_PAYLOAD_BYTES} with margin to spare.
 */
export const READ_FILE_CHUNK_BYTES = 4 * 1024 * 1024;

export const FRAME_HEADER_BYTES = 5;

/**
 * Frame kinds. Encoded as a single byte; the string union is what the code
 * switches on so an unhandled kind is a compile error rather than a silent
 * default.
 */
export type VmAgentFrameType =
  /** host → guest: JSON {@link VmAgentRequest} opening the stream. */
  | 'request'
  /** host → guest: raw stdin / PTY input bytes. */
  | 'stdin'
  /** guest → host: raw stdout bytes (also carries PTY output). */
  | 'stdout'
  /** guest → host: raw stderr bytes. */
  | 'stderr'
  /** guest → host: JSON {@link VmAgentStarted} once the process exists. */
  | 'started'
  /** guest → host: JSON {@link VmAgentExit}; last frame of a stream. */
  | 'exit'
  /** host → guest: JSON {@link VmAgentControl} (resize, signal, eof). */
  | 'control'
  /** guest → host: JSON {@link VmAgentReply} for a one-shot request. */
  | 'reply'
  /** guest → host: JSON {@link VmAgentError}; terminal for the stream. */
  | 'error';

const TYPE_TO_BYTE: Record<VmAgentFrameType, number> = {
  request: 0x01,
  stdin: 0x02,
  stdout: 0x03,
  stderr: 0x04,
  started: 0x05,
  exit: 0x06,
  control: 0x07,
  reply: 0x08,
  error: 0x09,
};

const BYTE_TO_TYPE = new Map<number, VmAgentFrameType>(
  Object.entries(TYPE_TO_BYTE).map(([type, byte]) => [byte, type as VmAgentFrameType]),
);

export interface VmAgentFrame {
  type: VmAgentFrameType;
  payload: Buffer;
}

// ── Request / response payloads ──────────────────────────────────

export interface VmAgentExecRequest {
  kind: 'exec';
  /** Run through `sh -c`, matching {@link SessionEnv.spawn}. */
  command: string;
  /** Absolute path **inside the guest**. The host resolves it before sending. */
  cwd: string;
  env: Record<string, string>;
  /** Log label; the guest echoes it back in errors. */
  name?: string;
}

export interface VmAgentPtyRequest {
  kind: 'pty';
  command: string;
  args: string[];
  cwd: string;
  /**
   * `null` unsets an inherited variable. JSON has no `undefined`, so the
   * SessionEnv `Record<string, string | undefined>` contract is carried as an
   * explicit null rather than an absent key — an absent key would be
   * indistinguishable from "leave it alone".
   */
  env: Record<string, string | null>;
  cols: number;
  rows: number;
  term: string;
}

/** Ports currently in LISTEN state inside the guest. */
export interface VmAgentListPortsRequest {
  kind: 'list-ports';
}

export interface VmAgentReadFileRequest {
  kind: 'read-file';
  path: string;
  /**
   * Byte range to return. A whole-file read of anything sizeable would exceed
   * {@link MAX_FRAME_PAYLOAD_BYTES} once base64-expanded, so bulk transfers
   * (a repo bundle on its way to a CI runner) page through the file instead.
   * Omitting both reads from the start to the frame limit.
   */
  offset?: number;
  length?: number;
}

export interface VmAgentWriteFileRequest {
  kind: 'write-file';
  path: string;
  /** base64 so the JSON envelope stays valid for binary content. */
  contentBase64: string;
  /** Octal mode string (e.g. "0644"); omitted leaves the default. */
  mode?: string;
}

export interface VmAgentPingRequest {
  kind: 'ping';
  protocolVersion: number;
}

export type VmAgentRequest =
  | VmAgentExecRequest
  | VmAgentPtyRequest
  | VmAgentListPortsRequest
  | VmAgentReadFileRequest
  | VmAgentWriteFileRequest
  | VmAgentPingRequest;

export interface VmAgentStarted {
  pid: number;
}

export interface VmAgentExit {
  /** null when the process was terminated by a signal. */
  code: number | null;
  signal: string | null;
}

export interface VmAgentError {
  message: string;
  /** Set when the failure is "no such command" so callers can map to ENOENT. */
  code?: string;
}

export interface VmAgentListeningPort {
  port: number;
  /** Bind address as reported by the guest, e.g. `0.0.0.0` or `127.0.0.1`. */
  address: string;
}

export type VmAgentReply =
  | { kind: 'pong'; protocolVersion: number; bootId: string }
  | { kind: 'ports'; ports: VmAgentListeningPort[] }
  /**
   * `eof` reports whether the range reached the end of the file, so a paging
   * reader knows to stop without a separate stat round trip — and, more
   * importantly, without inferring it from a short read, which is ambiguous.
   */
  | { kind: 'file'; contentBase64: string; eof: boolean }
  | { kind: 'written' };

export type VmAgentControl =
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'signal'; signal: string }
  /** Close the child's stdin without killing it. */
  | { kind: 'stdin-eof' };

// ── Encoding ─────────────────────────────────────────────────────

export function encodeFrame(type: VmAgentFrameType, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(
      `vm-agent frame payload of ${payload.length} bytes exceeds the ${MAX_FRAME_PAYLOAD_BYTES}-byte cap`,
    );
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt8(TYPE_TO_BYTE[type], 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(type: VmAgentFrameType, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function decodeJsonPayload<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf8')) as T;
}

/**
 * Incremental frame reader. vsock delivers a byte stream, so a frame can
 * arrive split across reads or several frames can land in one — feeding raw
 * chunks straight to a parser that assumed message boundaries is the classic
 * source of "works locally, corrupts under load" terminal bugs.
 */
export class VmAgentFrameDecoder {
  #buffered: Buffer = Buffer.alloc(0);

  /** Append a chunk and return every frame that is now complete. */
  push(chunk: Buffer): VmAgentFrame[] {
    this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
    const frames: VmAgentFrame[] = [];
    for (;;) {
      if (this.#buffered.length < FRAME_HEADER_BYTES) break;
      const typeByte = this.#buffered.readUInt8(0);
      const length = this.#buffered.readUInt32BE(1);
      if (length > MAX_FRAME_PAYLOAD_BYTES) {
        throw new Error(
          `vm-agent frame declares ${length} bytes, above the ${MAX_FRAME_PAYLOAD_BYTES}-byte cap ` +
            '(stream is desynchronized)',
        );
      }
      const total = FRAME_HEADER_BYTES + length;
      if (this.#buffered.length < total) break;
      const type = BYTE_TO_TYPE.get(typeByte);
      if (type === undefined) {
        throw new Error(`vm-agent frame has unknown type byte 0x${typeByte.toString(16)}`);
      }
      frames.push({
        type,
        payload: this.#buffered.subarray(FRAME_HEADER_BYTES, total),
      });
      this.#buffered = this.#buffered.subarray(total);
    }
    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pendingBytes(): number {
    return this.#buffered.length;
  }
}

/**
 * Firecracker's host-initiated vsock handshake: after connecting to the UDS
 * the host sends `CONNECT <port>\n` and the VMM replies `OK <hostPort>\n`
 * before any application bytes flow. Anything else means the guest is not
 * listening on that port yet.
 *
 * Returned as a pure pair so the connection code can be tested without a VM.
 */
export function vsockConnectCommand(port: number): Buffer {
  return Buffer.from(`CONNECT ${port}\n`, 'utf8');
}

export interface VsockHandshakeResult {
  ok: boolean;
  /** Bytes that followed the handshake line and belong to the stream. */
  rest: Buffer;
  /** Raw handshake line, for error reporting. */
  line: string;
}

/**
 * Parse the VMM's handshake reply out of the head of the stream. Returns
 * `null` while the terminating newline has not arrived yet, so the caller can
 * keep buffering rather than mistaking a short read for a rejection.
 */
export function parseVsockHandshake(buffered: Buffer): VsockHandshakeResult | null {
  const newline = buffered.indexOf(0x0a);
  if (newline === -1) return null;
  const line = buffered.subarray(0, newline).toString('utf8').trim();
  return {
    ok: /^OK\s+\d+$/.test(line),
    rest: buffered.subarray(newline + 1),
    line,
  };
}

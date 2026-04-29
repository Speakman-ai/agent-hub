/**
 * Runner client — opens an outbound WebSocket to the control plane,
 * sends `auth`, then handles `ping` (responds `pong`). Phase 1 only;
 * later phases will add `spawn`, `cancel`, `fs.*`, `git`, etc.
 *
 * Reconnect strategy: exponential backoff capped at 30s. The client
 * never gives up — long-lived runners are expected to outlive control-
 * plane deploys, network blips, and laptop sleep cycles.
 */
import os from 'os';
import { WebSocket } from 'ws';
import {
  RUNNER_PROTOCOL_VERSION,
  parseRunnerOutbound,
  type RunnerAuthMessage,
  type RunnerCapabilities,
  type RunnerInbound,
  type RunnerPongMessage,
} from '../../shared/runner-protocol.js';
import type { RunnerConfig } from './config.js';
import { SpawnRegistry, type SpawnerOptions } from './spawner.js';
import { KNOWN_ENGINES } from './engine-resolver.js';

const RUNNER_BUILD = '0.1.0';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RunnerClientOptions {
  config: RunnerConfig;
  /** Optional override for testing — defaults to `WebSocket` from `ws`. */
  WebSocketCtor?: typeof WebSocket;
  /** Logger — defaults to console. Tests can capture instead. */
  log?: (msg: string) => void;
  /** When true, give up on first auth failure instead of looping forever. */
  exitOnAuthError?: boolean;
  /** Override options handed to the lazily-created `SpawnRegistry`.
   * Production passes nothing; tests inject a fake `childSpawner` and a
   * 1ms flush interval so the e2e harness doesn't shell out to a real
   * binary or wait 50ms per assertion. */
  spawnerOptions?: Partial<Omit<SpawnerOptions, 'send'>>;
}

/**
 * Convert the configured base URL (e.g. `https://hub.example.com` or
 * `http://localhost:3051`) into the runner WS URL.
 */
export function buildRunnerWsUrl(hubUrl: string): string {
  const trimmed = hubUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('http://')) return trimmed.replace(/^http:/, 'ws:') + '/ws/runner';
  if (trimmed.startsWith('https://')) return trimmed.replace(/^https:/, 'wss:') + '/ws/runner';
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed + '/ws/runner';
  // Bare host:port — assume http.
  return 'ws://' + trimmed + '/ws/runner';
}

function defaultCapabilities(): RunnerCapabilities {
  return {
    os: process.platform,
    arch: process.arch,
    runnerVersion: RUNNER_BUILD,
    // Engines the runner can spawn — populated from `engine-resolver`'s
    // built-in defaults. Phase 2 enables CLI spawn end-to-end so this
    // is no longer empty.
    engines: KNOWN_ENGINES,
  };
}

export class RunnerClient {
  private ws: WebSocket | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private stopped = false;
  private readonly WSCtor: typeof WebSocket;
  private readonly log: (msg: string) => void;
  /** Lazily initialised on first spawn frame so unit tests that exercise
   * only the keepalive path don't pay for a registry they won't use. */
  private spawns: SpawnRegistry | null = null;

  constructor(private readonly opts: RunnerClientOptions) {
    this.WSCtor = opts.WebSocketCtor ?? WebSocket;
    this.log = opts.log ?? ((msg) => console.log(msg));
  }

  /** Send a frame to the control plane. Public so SpawnRegistry can
   * reuse it via the `send` callback. Silently drops if the socket is
   * closed — the control plane will surface the disconnect on its end. */
  private sendFrame(frame: RunnerInbound): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WSCtor.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log('[runner] send failed: ' + (err as Error).message);
    }
  }

  private getSpawns(): SpawnRegistry {
    if (!this.spawns) {
      this.spawns = new SpawnRegistry({
        send: (f) => this.sendFrame(f),
        ...(this.opts.spawnerOptions ?? {}),
      });
    }
    return this.spawns;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.close(1000, 'runner stopping');
      } catch {}
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = buildRunnerWsUrl(this.opts.config.hubUrl);
    this.log(`[runner] connecting to ${url} as ${this.opts.config.name} (${this.opts.config.runnerId})`);
    const ws = new this.WSCtor(url);
    this.ws = ws;

    ws.on('open', () => {
      const auth: RunnerAuthMessage = {
        type: 'auth',
        runnerId: this.opts.config.runnerId,
        token: this.opts.config.token,
        version: RUNNER_PROTOCOL_VERSION,
        capabilities: { ...defaultCapabilities(), hostname: os.hostname() },
      };
      try {
        ws.send(JSON.stringify(auth));
      } catch (err) {
        this.log('[runner] failed to send auth: ' + (err as Error).message);
      }
    });

    ws.on('message', (raw) => {
      const msg = parseRunnerOutbound(raw as Buffer | string);
      if (!msg) {
        this.log('[runner] received malformed frame; ignoring');
        return;
      }
      switch (msg.type) {
        case 'registered':
          this.backoffMs = RECONNECT_MIN_MS;
          this.log('[runner] registered with control plane');
          return;
        case 'auth_error':
          this.log(`[runner] auth_error (${msg.code}): ${msg.message}`);
          if (this.opts.exitOnAuthError) {
            this.stop();
          }
          return;
        case 'ping': {
          const pong: RunnerPongMessage = {
            type: 'pong',
            id: msg.id,
            ts: new Date().toISOString(),
          };
          this.sendFrame(pong);
          return;
        }
        case 'spawn':
          this.getSpawns().handleSpawn(msg);
          return;
        case 'cancel':
          this.getSpawns().handleCancel(msg);
          return;
        case 'stdin':
          this.getSpawns().handleStdin(msg);
          return;
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString('utf8') || '';
      this.log(`[runner] disconnected (code=${code} reason="${reasonStr}")`);
      this.ws = null;
      if (this.stopped) return;
      // Auth-failure close codes (4401) shouldn't trigger an immediate
      // reconnect storm — the token isn't going to change without
      // operator intervention. Back off harder.
      if (code === 4401) this.backoffMs = RECONNECT_MAX_MS;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.log('[runner] socket error: ' + (err as Error).message);
      // Let the close handler drive reconnect; we don't double-schedule.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.log(`[runner] reconnecting in ${delay}ms`);
    const t = setTimeout(() => this.connect(), delay);
    t.unref?.();
  }
}

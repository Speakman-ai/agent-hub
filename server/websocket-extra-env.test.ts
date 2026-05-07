/**
 * Regression test: WebSocket clients must not be able to inject extraEnv
 * into the spawned CLI process.
 *
 * websocket.ts strips `extraEnv` from client-sourced chat frames before
 * forwarding to handleChat, ensuring that only the autonomous-dispatch
 * in-process call site (server/autonomous.ts) — which never goes through
 * the WebSocket — is a legitimate producer of extraEnv.
 *
 * Without the strip, any authenticated WebSocket client could ship
 *   { type: 'chat', ..., extraEnv: { GH_TOKEN: '…', AGENT_HUB_URL: 'http://attacker/' } }
 * and override server-resolved credentials inside the spawned CLI process.
 */

import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import createWebSocket from './websocket.js';
import type { WebSocketDeps } from './types.js';

describe('WebSocket — extraEnv stripping', () => {
  it('strips extraEnv from a client chat frame before calling handleChat', async () => {
    const handleChat = vi.fn().mockResolvedValue(undefined);

    // Build a minimal standalone HTTP + WebSocket server so we can inject a
    // spy for handleChat without touching the running app server.
    const server = createServer();
    createWebSocket(server, {
      getProjects: () => [],
      handleChat,
      handleRoomChat: vi.fn().mockResolvedValue(undefined),
      handleCancel: vi.fn(),
      handleRoomCancel: vi.fn(),
      handleDelegationCancel: vi.fn(),
      handleDequeue: vi.fn(),
      handleEditQueueItem: vi.fn(),
      handleRoomDequeue: vi.fn(),
      handleDesignChat: vi.fn().mockResolvedValue(undefined),
      handleDesignCancel: vi.fn(),
    } as WebSocketDeps);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'chat',
              agentId: 'agent-strip-test',
              sessionId: 'sess-strip-test',
              content: 'hello',
              // These keys must NOT reach handleChat:
              extraEnv: { GH_TOKEN: 'client-injected', ANTHROPIC_API_KEY: 'hijacked' },
            }),
          );
          resolve();
        });
      });

      // Poll until the server has processed the message and called handleChat.
      await vi.waitFor(() => expect(handleChat).toHaveBeenCalledTimes(1), { timeout: 2000 });

      const [, chatMsg] = handleChat.mock.calls[0] as [unknown, Record<string, unknown>];
      // extraEnv must be absent — stripping happened before the call
      expect(chatMsg.extraEnv).toBeUndefined();
      // Other fields from the original message are still present
      expect(chatMsg.type).toBe('chat');
      expect(chatMsg.agentId).toBe('agent-strip-test');
      expect(chatMsg.content).toBe('hello');
    } finally {
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

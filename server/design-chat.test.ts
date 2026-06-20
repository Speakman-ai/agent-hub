/**
 * Unit tests for the pure helpers in design-chat.ts. The chat handler itself
 * spawns a real CLI and is exercised through integration tests; here we just
 * cover the state-inspection surface that the `/status` endpoint relies on.
 */
import { vi } from 'vitest';
import {
  getDesignStatus,
  activeDesignProcesses,
  resolveDesignStudioModel,
  handleDesignChat,
  initDesignChat,
} from './design-chat.js';
import type { AppConfig, DesignWithProjects } from './types.js';

function cfg(partial: Partial<AppConfig>): AppConfig {
  return partial as AppConfig;
}

describe('getDesignStatus', () => {
  afterEach(() => {
    // Keep the shared map clean between cases so test order doesn't matter.
    activeDesignProcesses.clear();
  });

  it('returns the no-turn sentinel when no process is registered', () => {
    expect(getDesignStatus('design-xyz')).toEqual({
      inFlight: false,
      messageId: null,
      streaming: '',
    });
  });

  it('reports the message id and latest cumulative stream when a turn is live', () => {
    activeDesignProcesses.set('design-abc', {
      proc: null,
      cancelled: false,
      messageId: 'msg-7',
      lastStream: 'hello world',
    } as unknown as Parameters<typeof activeDesignProcesses.set>[1]);

    expect(getDesignStatus('design-abc')).toEqual({
      inFlight: true,
      messageId: 'msg-7',
      streaming: 'hello world',
    });
  });

  it('resolveDesignStudioModel uses the design row when it is on the claude-code allowlist', () => {
    const c = cfg({
      engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'] },
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      defaultModel: 'claude-opus-4-8',
      allValidModels: ['claude-opus-4-8', 'claude-sonnet-4-6'],
    });
    expect(resolveDesignStudioModel('claude-sonnet-4-6', c)).toBe('claude-sonnet-4-6');
  });

  it('resolveDesignStudioModel falls back when the row is empty or not allowed', () => {
    const c = cfg({
      engineValidModels: { 'claude-code': ['claude-opus-4-8'] },
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
      defaultModel: 'claude-opus-4-8',
      allValidModels: ['claude-opus-4-8'],
    });
    expect(resolveDesignStudioModel(null, c)).toBe('claude-opus-4-8');
    expect(resolveDesignStudioModel('  ', c)).toBe('claude-opus-4-8');
    expect(resolveDesignStudioModel('not-on-list', c)).toBe('claude-opus-4-8');
  });

  it('refuses a chat turn on a migrated (imported) design and starts no turn', async () => {
    const broadcast = vi.fn();
    const migrated = {
      id: 'd-migrated',
      name: 'Old',
      imported_session_id: 'sess-1',
      agent_engine: null,
      agent_model: null,
      engine_session_id: null,
    } as unknown as DesignWithProjects;
    initDesignChat({
      broadcast,
      stmts: {},
      getDesign: () => migrated,
    } as unknown as Parameters<typeof initDesignChat>[0]);

    const ws = { send: vi.fn() };
    await handleDesignChat(
      ws as unknown as Parameters<typeof handleDesignChat>[0],
      {
        type: 'design_chat',
        designId: 'd-migrated',
        content: 'keep editing',
      } as unknown as Parameters<typeof handleDesignChat>[1],
    );

    // Sent a migrated error pointing at the session; no message was appended and
    // no turn was started (split-brain prevented).
    expect(ws.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(payload.code).toBe('design_migrated');
    expect(payload.sessionId).toBe('sess-1');
    expect(broadcast).not.toHaveBeenCalled();
    expect(activeDesignProcesses.has('d-migrated')).toBe(false);
  });

  it('treats a live entry with no streamed output yet as inFlight with empty text', () => {
    activeDesignProcesses.set('design-quiet', {
      proc: null,
      cancelled: false,
      messageId: 'msg-0',
      lastStream: '',
    } as unknown as Parameters<typeof activeDesignProcesses.set>[1]);

    expect(getDesignStatus('design-quiet')).toEqual({
      inFlight: true,
      messageId: 'msg-0',
      streaming: '',
    });
  });
});

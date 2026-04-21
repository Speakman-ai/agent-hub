/**
 * Unit tests for the pure helpers in design-chat.ts. The chat handler itself
 * spawns a real CLI and is exercised through integration tests; here we just
 * cover the state-inspection surface that the `/status` endpoint relies on.
 */
import { getDesignStatus, activeDesignProcesses, resolveDesignStudioModel } from './design-chat.js';
import type { AppConfig } from './types.js';

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
      engineValidModels: { 'claude-code': ['claude-opus-4-7', 'claude-sonnet-4-6'] },
      engineDefaultModels: { 'claude-code': 'claude-opus-4-7' },
      defaultModel: 'claude-opus-4-7',
      allValidModels: ['claude-opus-4-7', 'claude-sonnet-4-6'],
    });
    expect(resolveDesignStudioModel('claude-sonnet-4-6', c)).toBe('claude-sonnet-4-6');
  });

  it('resolveDesignStudioModel falls back when the row is empty or not allowed', () => {
    const c = cfg({
      engineValidModels: { 'claude-code': ['claude-opus-4-7'] },
      engineDefaultModels: { 'claude-code': 'claude-opus-4-7' },
      defaultModel: 'claude-opus-4-7',
      allValidModels: ['claude-opus-4-7'],
    });
    expect(resolveDesignStudioModel(null, c)).toBe('claude-opus-4-7');
    expect(resolveDesignStudioModel('  ', c)).toBe('claude-opus-4-7');
    expect(resolveDesignStudioModel('not-on-list', c)).toBe('claude-opus-4-7');
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

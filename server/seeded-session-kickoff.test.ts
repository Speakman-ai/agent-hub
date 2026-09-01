import { describe, it, expect, vi } from 'vitest';
import {
  abandonUnseededSession,
  kickoffSeededTurn,
  SeededTurnNotAcceptedError,
} from './seeded-session-kickoff.js';
import type { ChatMessage } from './types.js';

function persistHookOf(handleChat: ReturnType<typeof vi.fn>): (accepted: boolean) => void {
  const msg = handleChat.mock.calls[0]![1] as ChatMessage;
  const hook = msg._onUserMessagePersisted;
  if (!hook) throw new Error('missing persist hook');
  return hook;
}

describe('kickoffSeededTurn', () => {
  it('resolves once the persist hook reports accepted, without waiting for handleChat', async () => {
    let resume!: (value?: void) => void;
    const hanging = new Promise<void>((r) => {
      resume = r;
    });
    const handleChat = vi.fn((_ws: unknown, msg: ChatMessage) => {
      queueMicrotask(() => msg._onUserMessagePersisted?.(true));
      return hanging;
    });
    const onBackgroundError = vi.fn();

    await kickoffSeededTurn({
      handleChat,
      agentId: 'agent-1',
      sessionId: 'sess-1',
      content: 'seed',
      onBackgroundError,
    });

    expect(handleChat).toHaveBeenCalledOnce();
    expect(onBackgroundError).not.toHaveBeenCalled();
    resume();
  });

  it('rejects and does not leave the caller hanging when the turn is dropped', async () => {
    const handleChat = vi.fn(
      (_ws: unknown, msg: ChatMessage) =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            msg._onUserMessagePersisted?.(false);
            resolve();
          });
        }),
    );

    await expect(
      kickoffSeededTurn({
        handleChat,
        agentId: 'agent-1',
        sessionId: 'sess-1',
        content: 'seed',
      }),
    ).rejects.toBeInstanceOf(SeededTurnNotAcceptedError);
  });

  it('rejects when handleChat throws before persist', async () => {
    const handleChat = vi.fn(() => {
      throw new Error('engine unavailable');
    });

    await expect(
      kickoffSeededTurn({
        handleChat,
        agentId: 'agent-1',
        sessionId: 'sess-1',
        content: 'seed',
      }),
    ).rejects.toThrow('engine unavailable');
  });

  it('rejects when handleChat rejects before persist', async () => {
    const handleChat = vi.fn(() => Promise.reject(new Error('spawn failed')));

    await expect(
      kickoffSeededTurn({
        handleChat,
        agentId: 'agent-1',
        sessionId: 'sess-1',
        content: 'seed',
      }),
    ).rejects.toThrow('spawn failed');
  });

  it('keeps the accepted session when handleChat later rejects', async () => {
    const onBackgroundError = vi.fn();
    const handleChat = vi.fn((_ws: unknown, msg: ChatMessage) => {
      queueMicrotask(() => msg._onUserMessagePersisted?.(true));
      return Promise.reject(new Error('cli later'));
    });

    await kickoffSeededTurn({
      handleChat,
      agentId: 'agent-1',
      sessionId: 'sess-1',
      content: 'seed',
      onBackgroundError,
    });

    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalled());
    expect(onBackgroundError.mock.calls[0]![0]).toMatchObject({ message: 'cli later' });
    expect(persistHookOf(handleChat)).toBeTypeOf('function');
  });
});

describe('abandonUnseededSession', () => {
  it('deletes the session row so a retry cannot stack an empty sibling', () => {
    const run = vi.fn();
    abandonUnseededSession({ deleteSession: { run } } as never, 'sess-orphan');
    expect(run).toHaveBeenCalledWith('sess-orphan');
  });

  it('swallows delete failures so the caller can still return the seed error', () => {
    const run = vi.fn(() => {
      throw new Error('db locked');
    });
    expect(() =>
      abandonUnseededSession({ deleteSession: { run } } as never, 'sess-orphan'),
    ).not.toThrow();
  });
});

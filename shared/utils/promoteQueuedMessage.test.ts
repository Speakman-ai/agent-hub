import { describe, expect, it } from 'vitest';
import { promoteQueuedMessage } from './promoteQueuedMessage';

describe('promoteQueuedMessage', () => {
  it('moves the interrupt after the stopped output and preserves its attachments', () => {
    const prompt = { id: 'interrupt', queued: true, attachments: '[{"url":"/uploads/a.png"}]' };
    const result = promoteQueuedMessage([{ id: 'original' }, prompt, { id: 'partial' }], prompt.id);
    expect(result).toEqual([{ id: 'original' }, { id: 'partial' }, { ...prompt, queued: false }]);
    expect(prompt.queued).toBe(true);
    expect(promoteQueuedMessage(result, prompt.id)).toEqual(result);
  });

  it('restores a prompt outside the loaded page from the processing event', () => {
    const prompt = { id: 'interrupt', content: 'Updated queued text', queued: true };
    const messages: { id: string; content?: string; queued?: boolean }[] = [{ id: 'partial' }];
    expect(promoteQueuedMessage(messages, prompt.id, prompt)).toEqual([
      { id: 'partial' },
      { ...prompt, queued: false },
    ]);
  });

  it('uses the persisted content when the local copy is stale', () => {
    expect(
      promoteQueuedMessage([{ id: 'interrupt', content: 'old' }], 'interrupt', {
        id: 'interrupt',
        content: 'edited',
      }),
    ).toEqual([{ id: 'interrupt', content: 'edited', queued: false }]);
  });

  it('does not invent a visible message for an internal queued turn', () => {
    const messages = [{ id: 'partial' }];
    expect(promoteQueuedMessage(messages, 'internal')).toBe(messages);
  });
});

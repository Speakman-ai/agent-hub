import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHubChatRefCache } from './hubChatRefCache';

const resolveRefs = vi.fn();
const noHooks = {
  useSyncExternalStore: () => {
    throw new Error('not rendered here');
  },
  useEffect: () => {},
  useRef: <T>(current: T) => ({ current }),
};
const cache = createHubChatRefCache((refs) => resolveRefs(refs), noHooks as never);
const getHubChatRef = cache.get;
const requestHubChatRefs = cache.request;
const resetHubChatRefCache = cache.reset;

function resolved(title: string) {
  return {
    refs: [
      {
        kind: 'card',
        targetId: 'c1',
        visible: true,
        projectId: 'web',
        label: 'WEB-1',
        title,
        status: 'Done',
        agentId: null,
        number: null,
      },
    ],
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('hubChatRefCache identity scoping', () => {
  beforeEach(() => {
    resolveRefs.mockReset();
    resetHubChatRefCache();
  });

  it('forgets resolved refs when the account changes', async () => {
    resolveRefs.mockResolvedValue(resolved('Secret roadmap'));
    requestHubChatRefs([{ kind: 'card', targetId: 'c1' }]);
    await tick();
    expect(getHubChatRef('card', 'c1')?.title).toBe('Secret roadmap');
    resetHubChatRefCache();
    expect(getHubChatRef('card', 'c1')).toBeNull();
  });

  it('drops a lookup that was in flight for the previous account', async () => {
    let finish!: (v: unknown) => void;
    resolveRefs.mockReturnValueOnce(new Promise((r) => (finish = r)));
    requestHubChatRefs([{ kind: 'card', targetId: 'c1' }]);
    await tick();
    resetHubChatRefCache();
    finish(resolved('Previous viewer'));
    await tick();
    expect(getHubChatRef('card', 'c1')).toBeNull();
    // The new viewer asks again and gets their own answer.
    resolveRefs.mockResolvedValueOnce(resolved('New viewer'));
    requestHubChatRefs([{ kind: 'card', targetId: 'c1' }]);
    await tick();
    expect(getHubChatRef('card', 'c1')?.title).toBe('New viewer');
  });
});

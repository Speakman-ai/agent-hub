import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: { hubChat: { resolveRefs: vi.fn() } },
}));

import SessionTail from './SessionTail';
import { HubChatRefOpenContext, hasHubChatRefTokens } from './HubChatRefs';
import { api } from '../utils/api';
import { resetHubChatRefCacheForTests } from '../utils/hubChatRefCache';

const resolveRefs = (api as unknown as { hubChat: { resolveRefs: ReturnType<typeof vi.fn> } })
  .hubChat.resolveRefs;

const SESSION_REF = {
  kind: 'session',
  targetId: 's-new',
  visible: true,
  projectId: 'web',
  label: 'Fix login redirect',
  title: 'Fix login redirect',
  status: 'running',
  agentId: 'web-dev',
  number: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetHubChatRefCacheForTests();
  resolveRefs.mockResolvedValue({ refs: [SESSION_REF] });
});

describe('assistant replies with chat ref tokens', () => {
  it('renders a session token as a live chip that opens through the context handler', async () => {
    const open = vi.fn();
    render(
      <HubChatRefOpenContext.Provider value={open}>
        <SessionTail
          message={{
            id: 'a1',
            role: 'assistant',
            content: 'Started @[Fix login redirect](session:s-new) on Web Dev.',
            engine: 'claude-code',
          }}
          events={[]}
          agentColor="#22d3ee"
          agentName="Hub"
        />
      </HubChatRefOpenContext.Provider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-ref').getAttribute('data-visible')).toBe('true'),
    );
    expect(resolveRefs).toHaveBeenCalled();
    expect(screen.getByTestId('hub-chat-ref').textContent).toContain('Fix login redirect');

    fireEvent.click(screen.getByTestId('hub-chat-ref'));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', targetId: 's-new' }),
    );
  });

  it('leaves plain replies and tokens inside code alone', () => {
    expect(hasHubChatRefTokens('No refs here, just a [link](https://x.dev).')).toBe(false);
    expect(hasHubChatRefTokens('Use `@[label](session:abc)` to link.')).toBe(false);
    expect(hasHubChatRefTokens('See @[WEB-12](card:c12)')).toBe(true);

    render(
      <SessionTail
        message={{
          id: 'a2',
          role: 'assistant',
          content: 'Nothing to link.',
          engine: 'claude-code',
        }}
        events={[]}
        agentColor="#22d3ee"
      />,
    );
    expect(screen.getByText('Nothing to link.')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-chat-ref')).toBeNull();
    expect(resolveRefs).not.toHaveBeenCalled();
  });
});

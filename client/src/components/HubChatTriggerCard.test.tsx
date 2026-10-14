import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HubChatTriggerCard from './HubChatTriggerCard';
import { api } from '../utils/api';
import { resetHubChatRefCacheForTests } from '../utils/hubChatRefCache';
import type { ChatTriggerCard } from '@shared/utils/chatTriggers';

(vi as any).mock('../utils/api.js', () => ({
  api: { hubChat: { resolveRefs: vi.fn() } },
}));

const card: ChatTriggerCard = {
  type: 'trigger',
  event: 'pr_merged',
  triggerId: 't1',
  projectId: 'web',
  title: 'Pull request merged',
  status: 'success',
  statusLabel: 'Merged',
  detail: 'Add chat triggers',
  refs: [{ kind: 'pr', targetId: 'web#12', label: 'web#12' }],
};

describe('HubChatTriggerCard', () => {
  beforeEach(() => {
    resetHubChatRefCacheForTests();
    vi.mocked((api as any).hubChat.resolveRefs).mockResolvedValue({
      refs: [
        {
          kind: 'pr',
          targetId: 'web#12',
          visible: true,
          projectId: 'web',
          label: 'web#12',
          title: 'Add chat triggers',
          status: 'merged',
          agentId: null,
          number: 12,
        },
      ],
    });
  });

  it('renders status, detail, chips and an Open link to the main ref', async () => {
    const onOpenRef = vi.fn();
    render(<HubChatTriggerCard card={card} onOpenRef={onOpenRef} />);
    const el = screen.getByTestId('hub-chat-trigger-card');
    expect(el).toHaveAttribute('data-status', 'success');
    expect(el).toHaveTextContent('Pull request merged');
    expect(el).toHaveTextContent('Merged');
    expect(el).toHaveTextContent('Add chat triggers');

    const open = await screen.findByTestId('hub-chat-trigger-open');
    expect(open).toHaveAttribute('href', '/projects/web/pulls/12');
    fireEvent.click(open);
    await waitFor(() =>
      expect(onOpenRef).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pr', number: 12 })),
    );
  });

  it('has no Open link when the viewer cannot see the ref', async () => {
    vi.mocked((api as any).hubChat.resolveRefs).mockResolvedValue({
      refs: [{ kind: 'pr', targetId: 'web#12', visible: false }],
    });
    render(<HubChatTriggerCard card={card} />);
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-ref')).toHaveAttribute('data-visible', 'false'),
    );
    expect(screen.queryByTestId('hub-chat-trigger-open')).toBeNull();
  });
});

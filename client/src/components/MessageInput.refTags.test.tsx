import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: { hubChat: { searchRefs: vi.fn(), resolveRefs: vi.fn() } },
}));

import MessageInput from './MessageInput';
import ChatMessage from './ChatMessage';
import { api } from '../utils/api';
import { resetHubChatRefCacheForTests } from '../utils/hubChatRefCache';

const chat = (api as unknown as { hubChat: Record<string, ReturnType<typeof vi.fn>> }).hubChat;

const PR = {
  kind: 'pr',
  targetId: 'web#42',
  label: 'web#42',
  detail: 'Retry webhook delivery',
  projectId: 'web',
};

const baseProps = {
  onCancel: () => {},
  disabled: false,
  isProcessing: false,
  agentColor: '#4F46E5',
  skills: [],
  askMode: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetHubChatRefCacheForTests();
  chat.searchRefs.mockResolvedValue({ suggestions: [PR] });
  chat.resolveRefs.mockResolvedValue({
    refs: [
      {
        kind: 'pr',
        targetId: 'web#42',
        visible: true,
        projectId: 'web',
        label: 'web#42',
        title: 'Retry webhook delivery',
        status: 'open',
        agentId: null,
        number: 42,
      },
    ],
  });
});

function type(el: HTMLTextAreaElement, value: string) {
  fireEvent.change(el, { target: { value, selectionStart: value.length } } as any);
}

describe('session composer # tags', () => {
  it('picks a PR from # search and sends it as a ref token', async () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    type(textarea, 'Review #web');
    await waitFor(() => expect(screen.getByTestId('hub-chat-mention-popup')).toBeTruthy());
    expect(chat.searchRefs).toHaveBeenCalledWith('#', 'web');

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea.value).toBe('Review #web#42 '));

    type(textarea, 'Review #web#42 please');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('Review @[web\\#42](pr:web#42) please');
  });

  it('leaves @ to the agent picker and does not search refs', async () => {
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    type(textarea, 'hi @al');
    await new Promise((r) => setTimeout(r, 200));
    expect(chat.searchRefs).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend.mock.calls[0][0]).toBe('hi @al');
  });

  it('sends a hand-typed #text without a pick as plain text', async () => {
    chat.searchRefs.mockResolvedValue({ suggestions: [] });
    const onSend = vi.fn();
    render(<MessageInput {...baseProps} onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    type(textarea, 'fix #12 now');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend.mock.calls[0][0]).toBe('fix #12 now');
  });
});

describe('session bubbles render tags as chips', () => {
  it('shows a user message token as a live chip', async () => {
    render(
      <ChatMessage
        message={{ id: 'u1', role: 'user', content: 'Review @[web#42](pr:web#42) please' }}
        agentColor="#22d3ee"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('hub-chat-ref').getAttribute('data-visible')).toBe('true'),
    );
    expect(screen.getByTestId('hub-chat-ref').textContent).toContain('web#42');
    expect(screen.getByText(/Review/).textContent).not.toContain('pr:web#42');
  });
});

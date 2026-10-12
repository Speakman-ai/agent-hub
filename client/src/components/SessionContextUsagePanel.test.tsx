import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SessionContextUsagePanel from './SessionContextUsagePanel';
import { api } from '../utils/api';

describe('SessionContextUsagePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the total, percent, and non-empty categories', async () => {
    vi.spyOn(api, 'getSessionContextUsage').mockResolvedValue({
      sessionId: 's1',
      engine: 'claude-code',
      model: 'opus',
      source: 'reported',
      totalTokens: 146_000,
      contextWindow: 200_000,
      percent: 73,
      categories: [
        { key: 'system', label: 'System prompt', tokens: 1700 },
        { key: 'wiki', label: 'Wiki & retrieval', tokens: 0 },
        { key: 'conversation', label: 'Conversation', tokens: 144_300 },
      ],
      updatedAt: null,
    });
    render(<SessionContextUsagePanel sessionId="s1" onClose={() => {}} pollMs={60_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('context-usage-percent').textContent).toBe('73% Full'),
    );
    expect(screen.getByTestId('context-usage-total').textContent).toBe('146K / 200K Tokens');
    expect(screen.getByTestId('context-usage-row-system').textContent).toContain('1.7K');
    expect(screen.queryByTestId('context-usage-row-wiki')).toBeNull();
  });

  it('marks estimates and closes on the X button', async () => {
    vi.spyOn(api, 'getSessionContextUsage').mockResolvedValue({
      sessionId: 's2',
      engine: 'cursor-agent',
      model: 'auto',
      source: 'estimated',
      totalTokens: 2000,
      contextWindow: null,
      percent: null,
      categories: [{ key: 'conversation', label: 'Conversation', tokens: 2000 }],
      updatedAt: null,
    });
    const onClose = vi.fn();
    render(<SessionContextUsagePanel sessionId="s2" onClose={onClose} pollMs={60_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('context-usage-total').textContent).toBe('~2K Tokens'),
    );
    expect(screen.getByText(/Estimated from message size/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Close context usage/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the current session when a slow response for the previous one lands late', async () => {
    const make = (id: string, total: number) => ({
      sessionId: id,
      engine: 'claude-code',
      model: 'opus',
      source: 'reported' as const,
      totalTokens: total,
      contextWindow: 200_000,
      percent: (total / 200_000) * 100,
      categories: [{ key: 'conversation' as const, label: 'Conversation', tokens: total }],
      updatedAt: null,
    });
    let resolveA!: (v: ReturnType<typeof make>) => void;
    vi.spyOn(api, 'getSessionContextUsage').mockImplementation((id: string) =>
      id === 'A'
        ? new Promise((r) => {
            resolveA = r;
          })
        : Promise.resolve(make('B', 20_000)),
    );
    const { rerender } = render(
      <SessionContextUsagePanel sessionId="A" onClose={() => {}} pollMs={60_000} />,
    );
    rerender(<SessionContextUsagePanel sessionId="B" onClose={() => {}} pollMs={60_000} />);
    await waitFor(() =>
      expect(screen.getByTestId('context-usage-total').textContent).toBe('20K / 200K Tokens'),
    );
    await act(async () => {
      resolveA(make('A', 150_000));
    });
    expect(screen.getByTestId('context-usage-total').textContent).toBe('20K / 200K Tokens');
  });
});

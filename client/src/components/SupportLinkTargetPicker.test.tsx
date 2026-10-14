import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SupportLinkTargetPicker, {
  buildLinkTargetOptions,
  type LinkTarget,
} from './SupportLinkTargetPicker';
import { api } from '../utils/api';

vi.mock('../utils/api', () => ({
  api: { searchSupportTicketLinkTargets: vi.fn() },
}));

const searchMock = api.searchSupportTicketLinkTargets as unknown as ReturnType<typeof vi.fn>;

const TARGETS = {
  cards: [
    {
      id: 'card-1',
      short_id: 42,
      title: 'Fix export crash',
      column_name: 'In Progress',
      session_id: null,
      updated_at: '2026-10-14',
    },
  ],
  sessions: [
    {
      id: 'sess-1',
      name: 'Export investigation',
      agent_id: 'dev',
      agent_name: 'Dev',
      card_id: null,
      card_short_id: null,
      card_title: null,
      updated_at: '2026-10-14',
    },
  ],
};

function Harness({ onPick }: { onPick: (t: LinkTarget | null) => void }) {
  const [value, setValue] = useState<LinkTarget | null>(null);
  return (
    <SupportLinkTargetPicker
      projectId="p1"
      value={value}
      onChange={(t) => {
        setValue(t);
        onPick(t);
      }}
    />
  );
}

describe('buildLinkTargetOptions', () => {
  it('labels cards with their short id and flags sessions that will get a new card', () => {
    const opts = buildLinkTargetOptions(TARGETS);
    expect(opts[0]).toMatchObject({ kind: 'card', label: '#42 · Fix export crash' });
    expect(opts[1]).toMatchObject({ kind: 'session', label: 'Export investigation' });
    expect(opts[1].detail).toContain('one will be created');
  });

  it('returns nothing before results arrive', () => {
    expect(buildLinkTargetOptions(null)).toEqual([]);
  });
});

describe('SupportLinkTargetPicker', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue(TARGETS);
  });

  it('searches the server with the typed query and picks a session', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByTestId('link-target-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'export' } });

    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith('p1', 'export', expect.anything()),
    );
    const option = await screen.findByTestId('link-target-option-session');
    fireEvent.click(option);

    expect(onPick).toHaveBeenLastCalledWith({
      kind: 'session',
      id: 'sess-1',
      label: 'Export investigation',
    });
    expect(screen.queryByTestId('link-target-list')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('Export investigation');
  });

  it('supports keyboard selection', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByTestId('link-target-input');
    fireEvent.focus(input);
    await screen.findByTestId('link-target-option-card');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith({
      kind: 'card',
      id: 'card-1',
      label: '#42 · Fix export crash',
    });
  });

  it('ignores Enter while an IME composition is active', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByTestId('link-target-input');
    fireEvent.focus(input);
    await screen.findByTestId('link-target-option-card');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('link-target-list')).toBeTruthy();
  });

  it('does not select results from a previous query while the new search is pending', async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByTestId('link-target-input');
    fireEvent.focus(input);
    await screen.findByTestId('link-target-option-card');

    // The replacement search never resolves, so only stale results exist.
    searchMock.mockReturnValue(new Promise(() => {}));
    fireEvent.change(input, { target: { value: 'something else' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-target-option-card')).toBeNull();
    expect(screen.getByText('Searching…')).toBeTruthy();
    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith('p1', 'something else', expect.anything()),
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('points aria-activedescendant at the active option and clears it when none is selectable', async () => {
    render(<Harness onPick={vi.fn()} />);
    const input = screen.getByTestId('link-target-input');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.focus(input);

    const card = await screen.findByTestId('link-target-option-card');
    expect(card.id).toBeTruthy();
    expect(input.getAttribute('aria-activedescendant')).toBe(card.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const session = screen.getByTestId('link-target-option-session');
    expect(input.getAttribute('aria-activedescendant')).toBe(session.id);
    expect(session.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(session.id)).toBe(session);

    // A new query with a pending search leaves nothing selectable.
    searchMock.mockReturnValue(new Promise(() => {}));
    fireEvent.change(input, { target: { value: 'pending' } });
    expect(input.getAttribute('aria-activedescendant')).toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('shows an empty state when nothing matches', async () => {
    searchMock.mockResolvedValue({ cards: [], sessions: [] });
    render(<Harness onPick={vi.fn()} />);
    fireEvent.focus(screen.getByTestId('link-target-input'));
    expect(await screen.findByText('No matching cards or sessions')).toBeTruthy();
  });
});

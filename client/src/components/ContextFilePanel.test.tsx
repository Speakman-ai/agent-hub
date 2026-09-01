import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, within, act } from '@testing-library/react';
import ContextFilePanel from './ContextFilePanel';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    saveContext: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

describe('ContextFilePanel — cross-agent race safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.saveContext as any).mockResolvedValue({ ok: true });
  });

  it('resets the edit buffer on agent switch even when content is identical', async () => {
    const { getByRole, queryByRole, rerender, container } = render(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="SAME_BODY"
        agentId="agent-a"
        defaultExpanded
      />,
    );
    fireEvent.click(within(container).getByText('Edit'));
    // Agent A has an unsaved edit in the buffer.
    fireEvent.change(getByRole('textbox'), { target: { value: 'A_UNSAVED_EDIT' } });
    expect((getByRole('textbox') as HTMLTextAreaElement).value).toBe('A_UNSAVED_EDIT');

    // Switch to agent B whose file content is identical — only `agentId` changes.
    rerender(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="SAME_BODY"
        agentId="agent-b"
        defaultExpanded
      />,
    );
    expect(queryByRole('textbox')).toBeNull();

    // Reopen B's editor: it must show B's original content, NOT A's leftover buffer.
    fireEvent.click(within(container).getByText('Edit'));
    expect((getByRole('textbox') as HTMLTextAreaElement).value).toBe('SAME_BODY');
  });

  it('surfaces a conflict error and preserves the buffer when a save is rejected', async () => {
    (api.saveContext as any).mockRejectedValue(new Error('409: stale_write'));
    const onSaved = vi.fn();
    const { getByRole, getByText, getByTestId, queryByTestId, container } = render(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="BASE"
        agentId="agent-a"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    fireEvent.click(within(container).getByText('Edit'));
    fireEvent.change(getByRole('textbox'), { target: { value: 'MY EDIT' } });
    fireEvent.click(getByText('Save'));

    // Conflict is surfaced inline with reload/retry guidance.
    await waitFor(() =>
      expect(getByTestId('context-file-IDENTITY.md-save-error').textContent).toMatch(
        /changed since you opened it/i,
      ),
    );
    // Buffer preserved and editor still open; nothing applied.
    expect((getByRole('textbox') as HTMLTextAreaElement).value).toBe('MY EDIT');
    expect(onSaved).not.toHaveBeenCalled();

    // Editing again clears the error.
    fireEvent.change(getByRole('textbox'), { target: { value: 'MY EDIT 2' } });
    expect(queryByTestId('context-file-IDENTITY.md-save-error')).toBeNull();
  });

  it('shows a generic save error for a non-conflict failure', async () => {
    (api.saveContext as any).mockRejectedValue(new Error('500: boom'));
    const { getByRole, getByText, getByTestId, container } = render(
      <ContextFilePanel filename="IDENTITY.md" content="BASE" agentId="agent-a" defaultExpanded />,
    );
    fireEvent.click(within(container).getByText('Edit'));
    fireEvent.change(getByRole('textbox'), { target: { value: 'X' } });
    fireEvent.click(getByText('Save'));
    await waitFor(() =>
      expect(getByTestId('context-file-IDENTITY.md-save-error').textContent).toMatch(
        /could not save/i,
      ),
    );
  });

  it('discards an in-flight save whose agent is no longer current', async () => {
    let resolveSave!: (v: unknown) => void;
    (api.saveContext as any).mockImplementation(
      () =>
        new Promise((res) => {
          resolveSave = res;
        }),
    );
    const onSaved = vi.fn();
    const { getByText, rerender, container } = render(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_A_BODY"
        agentId="agent-a"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    fireEvent.click(within(container).getByText('Edit'));
    fireEvent.click(getByText('Save'));
    expect(api.saveContext as any).toHaveBeenCalledWith(
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Switch agents while the save is still pending.
    rerender(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_B_BODY"
        agentId="agent-b"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    resolveSave({});
    await waitFor(() => expect(api.saveContext as any).toHaveBeenCalledTimes(1));

    // The stale completion must not write agent A's buffer into agent B's panel.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('lets a second agent save while the first agent save is still pending', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    (api.saveContext as any).mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );
    const onSaved = vi.fn();
    const { getByText, rerender, container } = render(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_A_BODY"
        agentId="agent-a"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    // Agent A: edit + save, left in flight.
    fireEvent.click(within(container).getByText('Edit'));
    fireEvent.click(getByText('Save'));
    expect(api.saveContext as any).toHaveBeenNthCalledWith(
      1,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Switch to agent B while A's save is still pending.
    rerender(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_B_BODY"
        agentId="agent-b"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    fireEvent.click(within(container).getByText('Edit'));
    // B's Save button must NOT be disabled by A's still-pending save.
    const bSaveButton = getByText('Save').closest('button');
    expect(bSaveButton).toBeTruthy();
    expect(bSaveButton!.disabled).toBe(false);

    fireEvent.click(getByText('Save'));
    expect(api.saveContext as any).toHaveBeenNthCalledWith(
      2,
      'agent-b',
      'IDENTITY.md',
      'AGENT_B_BODY',
      'AGENT_B_BODY',
    );

    // B's save resolves first and applies independently.
    await act(async () => {
      resolvers[1]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('IDENTITY.md', 'AGENT_B_BODY');

    // A's late completion is stale: it must not call onSaved nor disturb B.
    await act(async () => {
      resolvers[0]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('treats a save from a prior visit as stale after an A -> B -> A round-trip', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    (api.saveContext as any).mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );
    const onSaved = vi.fn();
    const renderA = (
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_A_BODY"
        agentId="agent-a"
        defaultExpanded
        onSaved={onSaved}
      />
    );
    const { getByText, rerender, container } = render(renderA);

    // First visit to A: start a save (token 1), leave it pending.
    fireEvent.click(within(container).getByText('Edit'));
    fireEvent.click(getByText('Save'));
    expect(api.saveContext as any).toHaveBeenNthCalledWith(
      1,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );

    // Round-trip A -> B -> A. The second visit to A is a new generation.
    rerender(
      <ContextFilePanel
        filename="IDENTITY.md"
        content="AGENT_B_BODY"
        agentId="agent-b"
        defaultExpanded
        onSaved={onSaved}
      />,
    );
    rerender(renderA);

    // Second visit to A: its Save button is not stuck disabled by the old save.
    fireEvent.click(within(container).getByText('Edit'));
    const save2 = getByText('Save').closest('button');
    expect(save2!.disabled).toBe(false);
    // Start a second, current save for A (token 2); the button now shows Saving.
    fireEvent.click(getByText('Save'));
    expect(api.saveContext as any).toHaveBeenNthCalledWith(
      2,
      'agent-a',
      'IDENTITY.md',
      'AGENT_A_BODY',
      'AGENT_A_BODY',
    );
    expect(getByText('Saving...')).toBeTruthy();

    // The FIRST save resolves now. It belongs to the prior generation, so it
    // must neither call onSaved nor clear the second save's pending indicator.
    await act(async () => {
      resolvers[0]({});
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(getByText('Saving...')).toBeTruthy();

    // The second (current) save then resolves and applies.
    await act(async () => {
      resolvers[1]({});
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('IDENTITY.md', 'AGENT_A_BODY');
  });
});

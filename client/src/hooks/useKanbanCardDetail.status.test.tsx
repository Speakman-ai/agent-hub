import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKanbanCardDetail, endOfColumnPosition } from './useKanbanCardDetail';
import { api } from '../utils/api';

vi.mock('../utils/api.js', () => ({
  api: {
    getModelConfig: vi.fn().mockResolvedValue({ engineValidModels: {} }),
    getCardComments: vi.fn().mockResolvedValue([]),
    getCardReplay: vi.fn().mockResolvedValue(null),
    moveCard: vi.fn(),
  },
}));

const columns = [
  { id: 'col-todo', name: 'To Do' },
  { id: 'col-done', name: 'Done' },
];
const cards = [
  { id: 'c1', column_id: 'col-todo', position: 0, title: 'T' },
  { id: 'd1', column_id: 'col-done', position: 0 },
  { id: 'd2', column_id: 'col-done', position: 4 },
];

function setup() {
  const onRefresh = vi.fn().mockResolvedValue(cards);
  const hook = renderHook(() =>
    useKanbanCardDetail({ projectId: 'p1', cards, columns, onRefresh }),
  );
  act(() => hook.result.current.openDetail(cards[0]));
  return { ...hook, onRefresh };
}

describe('endOfColumnPosition', () => {
  it('appends after the highest position, ignoring the moving card', () => {
    expect(endOfColumnPosition(cards, 'col-done', 'c1')).toBe(5);
    expect(endOfColumnPosition(cards, 'col-empty')).toBe(0);
    expect(endOfColumnPosition(cards, 'col-todo', 'c1')).toBe(0);
  });
});

describe('useKanbanCardDetail — handleChangeStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves the card to the end of the chosen column and refreshes', async () => {
    (api.moveCard as any).mockResolvedValue({ id: 'c1', column_id: 'col-done', position: 5 });
    const { result, onRefresh } = setup();

    await act(async () => {
      await result.current.handleChangeStatus('col-done');
    });

    expect(api.moveCard).toHaveBeenCalledWith('p1', 'c1', { columnId: 'col-done', position: 5 });
    expect(result.current.selectedCard.column_id).toBe('col-done');
    expect(result.current.statusError).toBeNull();
    expect(onRefresh).toHaveBeenCalled();
  });

  it('is a no-op when the status is unchanged', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.handleChangeStatus('col-todo');
    });
    expect(api.moveCard).not.toHaveBeenCalled();
  });

  it('offers a force retry when the premature-Done guard rejects the move', async () => {
    (api.moveCard as any)
      .mockRejectedValueOnce(new Error('409: premature_done_move'))
      .mockResolvedValueOnce({ id: 'c1', column_id: 'col-done' });
    const { result } = setup();

    await act(async () => {
      await result.current.handleChangeStatus('col-done');
    });
    expect(result.current.statusError).toMatchObject({
      cardId: 'c1',
      columnId: 'col-done',
      canForce: true,
    });
    expect(result.current.selectedCard.column_id).toBe('col-todo');

    await act(async () => {
      await result.current.handleForceStatus();
    });
    expect(api.moveCard).toHaveBeenLastCalledWith('p1', 'c1', {
      columnId: 'col-done',
      position: 5,
      force: true,
    });
    expect(result.current.statusError).toBeNull();
    expect(result.current.selectedCard.column_id).toBe('col-done');
  });

  it('explains the Done-state contract rejection without a force option', async () => {
    (api.moveCard as any).mockRejectedValue(new Error('422: done_state_contract_violation'));
    const { result } = setup();
    await act(async () => {
      await result.current.handleChangeStatus('col-done');
    });
    expect(result.current.statusError?.canForce).toBe(false);
    expect(result.current.statusError?.message).toMatch(/follow-up/);
  });

  it('drops a rejection that lands after the user opened another card', async () => {
    let reject: (e: Error) => void = () => {};
    (api.moveCard as any).mockReturnValueOnce(
      new Promise((_res, rej) => {
        reject = rej;
      }),
    );
    const { result } = setup();

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleChangeStatus('col-done');
    });
    expect(result.current.statusMoving).toBe(true);

    const cardB = { id: 'b1', column_id: 'col-todo', position: 1, title: 'B' };
    act(() => result.current.openDetail(cardB));
    expect(result.current.statusMoving).toBe(false);

    await act(async () => {
      reject(new Error('409: premature_done_move'));
      await pending;
    });

    expect(result.current.selectedCard.id).toBe('b1');
    expect(result.current.statusError).toBeNull();
    await act(async () => {
      await result.current.handleForceStatus();
    });
    expect(api.moveCard).toHaveBeenCalledTimes(1);
  });

  it("hides card A's error while card B is open and never force-moves B", async () => {
    (api.moveCard as any).mockRejectedValueOnce(new Error('409: premature_done_move'));
    const { result } = setup();
    await act(async () => {
      await result.current.handleChangeStatus('col-done');
    });
    expect(result.current.statusError?.cardId).toBe('c1');

    act(() => result.current.setSelectedCard({ id: 'b1', column_id: 'col-todo', title: 'B' }));
    expect(result.current.statusError).toBeNull();
    await act(async () => {
      await result.current.handleForceStatus();
    });
    expect(api.moveCard).toHaveBeenCalledTimes(1);
  });

  it('only updates the draft column for unsaved cards', async () => {
    const { result } = renderHook(() => useKanbanCardDetail({ projectId: 'p1', cards, columns }));
    act(() => result.current.openCreateDetail('col-todo'));
    await act(async () => {
      await result.current.handleChangeStatus('col-done');
    });
    expect(api.moveCard).not.toHaveBeenCalled();
    expect(result.current.selectedCard.column_id).toBe('col-done');
  });
});

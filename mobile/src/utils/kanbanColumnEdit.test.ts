import { describe, expect, it } from 'vitest';
import { buildKanbanColumnEditPayload } from './kanbanColumnEdit';

describe('buildKanbanColumnEditPayload', () => {
  it('omits position so rename and color saves cannot overwrite reordered columns', () => {
    const payload = buildKanbanColumnEditPayload({
      currentName: 'QA',
      nextName: ' Review ',
      color: '#123456',
      locked: false,
    });

    expect(payload).toEqual({ name: 'Review', color: '#123456' });
    expect(payload).not.toHaveProperty('position');
  });

  it('keeps locked system column names while allowing color changes', () => {
    expect(
      buildKanbanColumnEditPayload({
        currentName: 'Done',
        nextName: 'Complete',
        color: '#22c55e',
        locked: true,
      }),
    ).toEqual({ name: 'Done', color: '#22c55e' });
  });
});

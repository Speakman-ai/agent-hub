import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

/**
 * PhaseFlowchartView drag-and-drop — tickets between phase columns.
 *
 * jsdom has no layout engine, so dnd-kit's pointer sensor pipeline can't run
 * here. We mock ONLY the dnd-kit rendering/sensor layer: <DndContext> becomes a
 * passthrough that captures the `onDragStart` / `onDragEnd` props the view wires
 * up, so the test can invoke the view's REAL `handleDragEnd` with authentic
 * dnd-kit event shapes and assert on the move handler it calls.
 */

const dnd: Record<string, any> = { handlers: {} };

(vi as any).mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd, onDragCancel }: any) => {
    dnd.handlers.onDragStart = onDragStart;
    dnd.handlers.onDragEnd = onDragEnd;
    dnd.handlers.onDragCancel = onDragCancel;
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: any) => <div data-testid="drag-overlay">{children}</div>,
  PointerSensor: function PointerSensor() {},
  KeyboardSensor: function KeyboardSensor() {},
  useSensor: () => ({}),
  useSensors: (...sensors: any) => sensors,
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    isDragging: false,
  }),
  closestCorners: () => [],
}));

(vi as any).mock('@dnd-kit/utilities', () => ({
  CSS: { Translate: { toString: () => '' } },
}));

import PhaseFlowchartView from './PhaseFlowchartView';

const columns = [
  { id: 'c1', name: 'To Do' },
  { id: 'c2', name: 'In Progress' },
  { id: 'c3', name: 'Done' },
];

const phases = [
  { id: 'p1', name: 'Phase One', position: 0 },
  { id: 'p2', name: 'Phase Two', position: 1 },
];

const tickets = [
  { id: 't1', phase_id: 'p1', column_id: 'c1', title: 'Ticket One' },
  { id: 't2', phase_id: 'p2', column_id: 'c1', title: 'Ticket Two' },
];

// Drive the view's real onDragEnd with a dnd-kit-shaped event.
const dragEnd = async ({ ticketId, sourcePhaseId, overId }: any) => {
  await act(async () => {
    await dnd.handlers.onDragEnd({
      active: { id: ticketId, data: { current: { ticketId, phaseId: sourcePhaseId } } },
      over: overId == null ? null : { id: overId },
    });
  });
};

beforeEach(() => {
  dnd.handlers = {};
});

describe('PhaseFlowchartView ticket drag-and-drop', () => {
  it('does not enable dragging (no DndContext) without onMoveTicketToPhase', () => {
    render(
      <PhaseFlowchartView phases={phases} tickets={tickets} columns={columns} phaseForms={{}} />,
    );
    expect(screen.queryByTestId('dnd-context')).toBeNull();
  });

  it('renders inside a DndContext when onMoveTicketToPhase is provided', () => {
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={tickets}
        columns={columns}
        phaseForms={{}}
        onMoveTicketToPhase={() => {}}
      />,
    );
    expect(screen.getByTestId('dnd-context')).not.toBeNull();
  });

  it('dropping a ticket on another phase calls onMoveTicketToPhase(ticketId, targetPhaseId)', async () => {
    const onMoveTicketToPhase = vi.fn();
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={tickets}
        columns={columns}
        phaseForms={{}}
        onMoveTicketToPhase={onMoveTicketToPhase}
      />,
    );

    await dragEnd({ ticketId: 't1', sourcePhaseId: 'p1', overId: 'phase-drop:p2' });

    expect(onMoveTicketToPhase).toHaveBeenCalledWith('t1', 'p2');
  });

  it('dropping a ticket back on its own phase is a no-op', async () => {
    const onMoveTicketToPhase = vi.fn();
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={tickets}
        columns={columns}
        phaseForms={{}}
        onMoveTicketToPhase={onMoveTicketToPhase}
      />,
    );

    await dragEnd({ ticketId: 't1', sourcePhaseId: 'p1', overId: 'phase-drop:p1' });

    expect(onMoveTicketToPhase).not.toHaveBeenCalled();
  });

  it('dropping outside any phase droppable is a no-op', async () => {
    const onMoveTicketToPhase = vi.fn();
    render(
      <PhaseFlowchartView
        phases={phases}
        tickets={tickets}
        columns={columns}
        phaseForms={{}}
        onMoveTicketToPhase={onMoveTicketToPhase}
      />,
    );

    await dragEnd({ ticketId: 't1', sourcePhaseId: 'p1', overId: null });
    expect(onMoveTicketToPhase).not.toHaveBeenCalled();

    // A non-phase droppable id is also ignored.
    await dragEnd({ ticketId: 't1', sourcePhaseId: 'p1', overId: 'something-else' });
    expect(onMoveTicketToPhase).not.toHaveBeenCalled();
  });
});

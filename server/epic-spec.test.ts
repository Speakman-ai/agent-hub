import { describe, expect, it } from 'vitest';
import {
  formatEpicSpecDecisionsForContext,
  isSpikeCard,
  normalizeSpecItemStatus,
  buildSpikeSessionContext,
  buildSpikeSessionContextFallback,
  deriveSpecTagFromSpikeTitle,
} from './epic-spec.js';
import type { KanbanCardRow, KanbanEpicSpecItemRow } from './types.js';

const baseSpec = (over: Partial<KanbanEpicSpecItemRow>): KanbanEpicSpecItemRow => ({
  id: 'spec-1',
  epic_id: 'epic-1',
  board_id: 'board-1',
  phase_id: null,
  tag: 'MODEL',
  title: 'Phase table shape',
  decision: null,
  status: 'open',
  position: 0,
  spike_card_id: null,
  resolved_session_id: null,
  created_at: '',
  updated_at: '',
  ...over,
});

describe('epic-spec', () => {
  it('isSpikeCard detects spike kind', () => {
    expect(isSpikeCard({ card_kind: 'spike' })).toBe(true);
    expect(isSpikeCard({ card_kind: 'task' })).toBe(false);
    expect(isSpikeCard({})).toBe(false);
    expect(isSpikeCard({ title: 'Spike: pick delivery model' })).toBe(true);
    expect(isSpikeCard({ title: 'Implement spike detector' })).toBe(false);
  });

  it('normalizeSpecItemStatus falls back to open', () => {
    expect(normalizeSpecItemStatus('chosen')).toBe('chosen');
    expect(normalizeSpecItemStatus('nope')).toBe('open');
  });

  it('formatEpicSpecDecisionsForContext includes only chosen items with text', () => {
    const block = formatEpicSpecDecisionsForContext([
      baseSpec({ status: 'open' }),
      baseSpec({
        id: 'spec-2',
        tag: 'EDGES',
        title: 'Sequential only',
        status: 'chosen',
        decision: 'Left-to-right phase order; no phase graph.',
      }),
    ]);
    expect(block).toContain('Epic spec decisions');
    expect(block).toContain('Sequential only');
    expect(block).not.toContain('Phase table shape');
  });

  it('buildSpikeSessionContext references spec item and API', () => {
    const card = {
      id: 'card-spike',
      title: 'Spike: Phase table shape',
      description: 'notes',
    } as KanbanCardRow;
    const ctx = buildSpikeSessionContext({
      card,
      specItem: baseSpec({ id: 'spec-abc' }),
      projectId: 'agent-hub',
    });
    expect(ctx).toContain('spec-abc');
    expect(ctx).toContain('/board/spec-items/spec-abc');
    expect(ctx).toContain('No code');
    expect(ctx).toContain('Spec decisions');
  });

  it('deriveSpecTagFromSpikeTitle picks a unique tag', () => {
    expect(deriveSpecTagFromSpikeTitle('Spike: choose chat delivery', new Set())).toBe('CHOOSE');
    expect(deriveSpecTagFromSpikeTitle('Spike: choose chat delivery', new Set(['CHOOSE']))).toBe(
      'CHOOSE2',
    );
  });

  it('buildSpikeSessionContextFallback requires epic spec output', () => {
    const ctx = buildSpikeSessionContextFallback({
      card: {
        id: 'c1',
        title: 'Spike: polling vs websocket',
        epic_id: 'epic-1',
        phase_id: 'phase-1',
      } as KanbanCardRow,
      projectId: 'agent-hub',
    });
    expect(ctx).toContain('Spec decisions');
    expect(ctx).toContain('No code');
    expect(ctx).toContain('/board/spec-items');
  });
});

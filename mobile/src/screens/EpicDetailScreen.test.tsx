import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Render RN primitives as plain host string tags so renderToStaticMarkup can
// serialize the trees without a native runtime (same approach as
// TodosScreen.test.tsx / CalendarScreen.test.tsx).
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: () => {} },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ setActiveAgentId() {}, setActiveSessionId() {} }) }));
vi.mock('../utils/api', () => ({ api: {} }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: () => null }));
vi.mock('../components/LinkedTodosPanel', () => ({ default: () => null }));

import { EpicSummary, SpecItemRow, PhaseCard } from './EpicDetailScreen';

const columns = [
  { id: 'c1', name: 'To Do' },
  { id: 'c2', name: 'In Progress' },
  { id: 'c3', name: 'Done' },
];
const noop = () => {};

describe('EpicDetailScreen — EpicSummary', () => {
  it('shows spec-locked, ticket, and phase counts plus autonomous badge', () => {
    const html = renderToStaticMarkup(
      <EpicSummary
        epic={{ id: 'e1', name: 'Mobile parity', description: 'Ship the app', color: '#22C55E' }}
        phases={[{ autonomous: 1 }, { autonomous: 1 }]}
        tickets={[
          { id: 'a', column_id: 'c3' },
          { id: 'b', column_id: 'c1' },
        ]}
        columns={columns}
        specItems={[{ status: 'chosen' }, { status: 'open' }]}
      />,
    );
    expect(html).toContain('Mobile parity');
    expect(html).toContain('1/2 locked'); // spec
    expect(html).toContain('ALL AUTO'); // autonomous summary
    // Open spec decision => warning to lock before autonomous runs.
    expect(html).toContain('Lock all open spec decisions');
  });

  it('renders nothing without an epic', () => {
    const html = renderToStaticMarkup(
      <EpicSummary epic={null} phases={[]} tickets={[]} columns={columns} specItems={[]} />,
    );
    expect(html).toBe('');
  });
});

describe('EpicDetailScreen — SpecItemRow', () => {
  it('shows a locked decision with its text', () => {
    const html = renderToStaticMarkup(
      <SpecItemRow
        item={{ id: 's1', tag: 'data-model', title: 'How to store it?', status: 'chosen', decision: 'Use SQLite' }}
        saving={null}
        onDecideForMe={noop}
        onUpdateSpecItem={noop}
      />,
    );
    expect(html).toContain('data-model');
    expect(html).toContain('How to store it?');
    expect(html).toContain('Locked');
    expect(html).toContain('Use SQLite');
  });

  it('offers decide-for-me and write-decision on an open item', () => {
    const html = renderToStaticMarkup(
      <SpecItemRow
        item={{ id: 's2', tag: 'nav', title: 'Which nav?', status: 'open' }}
        saving={null}
        onDecideForMe={noop}
        onUpdateSpecItem={noop}
      />,
    );
    expect(html).toContain('Open');
    expect(html).toContain('Decide for me');
    expect(html).toContain('Write decision');
  });

  it('offers an Open-linked-card action when the item has a spike card', () => {
    const html = renderToStaticMarkup(
      <SpecItemRow
        item={{ id: 's3', tag: 'nav', title: 'Which nav?', status: 'open', spike_card_id: 'k42' }}
        saving={null}
        onDecideForMe={noop}
        onUpdateSpecItem={noop}
        onOpenCard={noop}
      />,
    );
    expect(html).toContain('Open linked card');
  });

  it('hides the Open-linked-card action when there is no spike card', () => {
    const html = renderToStaticMarkup(
      <SpecItemRow
        item={{ id: 's4', tag: 'nav', title: 'Which nav?', status: 'open' }}
        saving={null}
        onDecideForMe={noop}
        onUpdateSpecItem={noop}
        onOpenCard={noop}
      />,
    );
    expect(html).not.toContain('Open linked card');
  });
});

describe('EpicDetailScreen — PhaseCard', () => {
  const phase = { id: 'p1', name: 'Foundation', autonomous: 1 };

  it('renders phase name, ticket count, and a Run button when spec is ready', () => {
    const html = renderToStaticMarkup(
      <PhaseCard
        phase={phase}
        index={0}
        tickets={[
          { id: 'a', phase_id: 'p1', column_id: 'c3', title: 'Done ticket' },
          { id: 'b', phase_id: 'p1', column_id: 'c1', title: 'Todo ticket' },
        ]}
        columns={columns}
        form={{ autonomous: 1, autonomous_max_concurrent: 2, autonomous_send_it: 1, autonomous_model: '' }}
        modelConfig={null}
        specReady
        running={false}
        stopping={false}
        addingTicket={false}
        onFormChange={noop}
        onRun={noop}
        onStop={noop}
        onAddTicket={noop}
        onOpenCard={noop}
      />,
    );
    expect(html).toContain('Foundation');
    expect(html).toContain('1/2'); // done/total tickets
    expect(html).toContain('Run phase');
    expect(html).toContain('Done ticket');
    expect(html).toContain('Todo ticket');
  });

  it('disables running with a hint when spec is not ready', () => {
    const html = renderToStaticMarkup(
      <PhaseCard
        phase={phase}
        index={1}
        tickets={[]}
        columns={columns}
        form={{ autonomous: 1, autonomous_max_concurrent: 1, autonomous_send_it: 0, autonomous_model: '' }}
        modelConfig={null}
        specReady={false}
        running={false}
        stopping={false}
        addingTicket={false}
        onFormChange={noop}
        onRun={noop}
        onStop={noop}
        onAddTicket={noop}
        onOpenCard={noop}
      />,
    );
    expect(html).toContain('Lock spec to run');
    expect(html).toContain('No tickets yet');
  });

  it('shows a Stop control while the phase is running', () => {
    const html = renderToStaticMarkup(
      <PhaseCard
        phase={phase}
        index={0}
        tickets={[]}
        columns={columns}
        form={{ autonomous: 1, autonomous_max_concurrent: 1, autonomous_send_it: 1, autonomous_model: '' }}
        modelConfig={null}
        specReady
        running
        stopping={false}
        addingTicket={false}
        onFormChange={noop}
        onRun={noop}
        onStop={noop}
        onAddTicket={noop}
        onOpenCard={noop}
      />,
    );
    expect(html).toContain('Running');
    expect(html).toContain('Stop');
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// RN primitives rendered as host string tags so react-dom/server can serialize
// the tree without a native runtime. Matches the LinkedTodosPanel test pattern.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  Linking: { openURL: () => Promise.resolve() },
}));
// The component imports the api module transitively; stub it so importing the
// content component never reaches the network layer.
vi.mock('../utils/api', () => ({ api: { getEpicPulls: () => Promise.resolve({ pulls: [] }) } }));

import { EpicPullsSectionContent, relationLabel, stateLabel } from './EpicPullsSection';

describe('relationLabel / stateLabel', () => {
  it('maps relations', () => {
    expect(relationLabel('integration')).toBe('Ships branch');
    expect(relationLabel('targets')).toBe('Targets branch');
    expect(relationLabel('other')).toBe('Targets branch');
  });
  it('maps PR state to a label', () => {
    expect(stateLabel({ merged: true }).label).toBe('Merged');
    expect(stateLabel({ state: 'closed' }).label).toBe('Closed');
    expect(stateLabel({ state: 'open' }).label).toBe('Open');
  });
});

describe('EpicPullsSectionContent (mobile)', () => {
  it('renders nothing when there are no PRs', () => {
    expect(renderToStaticMarkup(<EpicPullsSectionContent pulls={[]} />)).toBe('');
  });

  it('lists PRs with relation + state labels', () => {
    const html = renderToStaticMarkup(
      <EpicPullsSectionContent
        pulls={[
          { number: 7, title: 'Ship the branch', state: 'open', merged: false, relation: 'integration' },
          { number: 8, title: 'Ticket work', state: 'closed', merged: true, relation: 'targets' },
        ]}
      />,
    );
    expect(html).toContain('epic-pulls-section');
    expect(html).toContain('2 pull requests on this feature branch.');
    expect(html).toContain('Ship the branch');
    expect(html).toContain('Ships branch');
    expect(html).toContain('Targets branch');
    expect(html).toContain('Merged');
    expect(html).toContain('epic-pull-7');
  });
});

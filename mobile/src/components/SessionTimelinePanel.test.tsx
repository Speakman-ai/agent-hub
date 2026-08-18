import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
}));

vi.mock('./AppIcon', () => ({
  default: ({ name }: any) => React.createElement('AppIcon', { 'data-name': name }),
}));

import { SessionTimelinePanelContent } from './SessionTimelinePanel';

describe('SessionTimelinePanelContent (mobile)', () => {
  it('renders the empty copy when there are no markers', () => {
    const html = renderToStaticMarkup(<SessionTimelinePanelContent markers={[]} />);
    expect(html).toContain('session-timeline-panel');
    expect(html).toContain('change summary, finalize checks, and review comment');
  });

  it('lists markers with kind labels and titles', () => {
    const html = renderToStaticMarkup(
      <SessionTimelinePanelContent
        markers={[
          {
            id: 'a',
            kind: 'change_summary',
            messageId: 'm1',
            anchorId: 'change-summary:m1',
            createdAt: null,
            title: 'Adds the timeline rail.',
            subtitle: '2 files changed',
            status: 'neutral',
          },
          {
            id: 'b',
            kind: 'test_run',
            messageId: 'm2',
            anchorId: 'test-run:checks:m2',
            createdAt: null,
            title: 'Checks · round 1',
            subtitle: '1/1 passed',
            status: 'ok',
          },
          {
            id: 'c',
            kind: 'review_comment',
            messageId: 'm3',
            anchorId: 'review-comment:th1',
            createdAt: null,
            title: 'Extract the toggle.',
            subtitle: 'App.tsx:10',
            status: 'neutral',
          },
        ]}
      />,
    );
    expect(html).toContain('Adds the timeline rail.');
    expect(html).toContain('Checks · round 1');
    expect(html).toContain('Extract the toggle.');
    expect(html).toContain('Change summary');
    expect(html).toContain('Checks');
    expect(html).toContain('Review comment');
  });
});

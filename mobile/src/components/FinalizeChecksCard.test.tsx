import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Platform: { select: (o: any) => o.default },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
}));
vi.mock('./AppIcon', () => ({ default: (props: any) => <i data-name={props.name} /> }));
vi.mock('../utils/api', () => ({ api: {} }));

import FinalizeChecksCard from './FinalizeChecksCard';
import { readTestSelection } from '@shared/utils/testSelectionDisplay';

const selection = readTestSelection({
  test_selection: JSON.stringify({
    mode: 'dynamic',
    forcedFullReason: null,
    inventorySha: 'abc',
    instances: [
      {
        jobId: 'server',
        matrixKey: '',
        selected: true,
        sources: ['session'],
        files: [],
        reasons: [],
      },
      { jobId: 'client', matrixKey: '', selected: false, sources: [], files: [], reasons: [] },
    ],
  }),
});

describe('FinalizeChecksCard test selection', () => {
  it('counts not_selected steps apart and shows why they were skipped', () => {
    const html = renderToStaticMarkup(
      <FinalizeChecksCard
        selection={selection}
        steps={[
          { name: 'server / test', state: 'passed', job_id: 'server', matrix_key: '' },
          { name: 'client / test', state: 'not_selected', job_id: 'client', matrix_key: '' },
        ]}
      />,
    );
    expect(html).toContain('1/1 passed · 1 not selected');
    expect(html).toContain('not selected · No test in this instance');
    expect(html).toContain('Test selection · selected 1 of 2 jobs');
  });

  it('renders no manifest without a selection', () => {
    const html = renderToStaticMarkup(
      <FinalizeChecksCard steps={[{ name: 'lint', state: 'passed' }]} />,
    );
    expect(html).not.toContain('Test selection');
  });
});

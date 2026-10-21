import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: (props: any) => <textarea defaultValue={props.value} />,
  Switch: (props: any) => (
    <input type="checkbox" readOnly checked={props.value} disabled={props.disabled} />
  ),
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));

import TestSelectionSection from './TestSelectionSection';
import { DEFAULT_FULL_RUN_PATHS, DYNAMIC_NEEDS_CI_ON_PUSH_HINT } from '@shared/utils/testSelection';

const tests = [
  { job_id: 'lint', configured: true },
  { job_id: 'server-tests', matrix_key: '1', configured: true },
];

describe('TestSelectionSection', () => {
  it('disables the dynamic switch and explains why while CI on push is off', () => {
    const html = renderToStaticMarkup(
      <TestSelectionSection settings={undefined} ciOnPushEnabled={false} tests={tests} />,
    );
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain(DYNAMIC_NEEDS_CI_ON_PUSH_HINT.slice(0, 30));
  });

  it('enables the switch with CI on push and lists the configured jobs', () => {
    const html = renderToStaticMarkup(
      <TestSelectionSection
        settings={{ mode: 'dynamic', alwaysRun: ['lint'], fullRunPaths: ['proto/**'] }}
        ciOnPushEnabled
        tests={tests}
      />,
    );
    expect(html).not.toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*checked/);
    expect(html).toContain('lint');
    expect(html).toContain('server-tests');
    expect(html).toContain('proto/**');
    expect(html).toContain(`${DEFAULT_FULL_RUN_PATHS.length} built-in paths`);
  });

  it('shows the empty job state without stats', () => {
    const html = renderToStaticMarkup(
      <TestSelectionSection settings={{}} ciOnPushEnabled tests={null} />,
    );
    expect(html).toContain('No jobs found');
  });
});

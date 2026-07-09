import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: ({ children }: any) => <button>{children}</button>,
  View: 'View',
}));
vi.mock('../../utils/api', () => ({
  api: {
    getJobs: vi.fn(() => Promise.resolve({ jobs: [], counts: {}, types: [] })),
    retryJob: vi.fn(() => Promise.resolve({})),
    deleteJob: vi.fn(() => Promise.resolve({})),
  },
}));

import JobQueueSection, { STATUS_FILTERS, jobIsRetryable } from './JobQueueSection';

describe('jobIsRetryable', () => {
  it('is true only for dead-lettered jobs', () => {
    expect(jobIsRetryable('dead_letter')).toBe(true);
    expect(jobIsRetryable('queued')).toBe(false);
    expect(jobIsRetryable('running')).toBe(false);
    expect(jobIsRetryable('done')).toBe(false);
  });
});

describe('STATUS_FILTERS', () => {
  it('offers all four job states plus an All option', () => {
    const values = STATUS_FILTERS.map((f) => f.value);
    expect(values).toEqual(['', 'queued', 'running', 'done', 'dead_letter']);
  });
});

describe('JobQueueSection', () => {
  it('renders the pane header without crashing', () => {
    const html = renderToStaticMarkup(<JobQueueSection />);
    expect(html).toContain('Background Jobs');
  });
});

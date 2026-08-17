import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TurnChangeSummaryBlock from './TurnChangeSummaryBlock';
import { parseTurnChangeSummaryMetadata } from '../../../utils/turnChangeSummary';

function turnMessage(payload: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    created_at: '2026-08-17T12:00:00Z',
    role: 'system',
    metadata: JSON.stringify({
      kind: 'turn_change_summary',
      summary: 'Adds a settings toggle and wires it to the config store.',
      summarySource: 'llm',
      manualTesting: [
        'Open the Settings page and flip the new toggle.',
        'Reload and confirm it persists.',
      ],
      filesChanged: 2,
      insertions: 40,
      deletions: 3,
      ...payload,
    }),
  };
}

describe('parseTurnChangeSummaryMetadata', () => {
  it('parses the flat server-shaped metadata', () => {
    const meta = parseTurnChangeSummaryMetadata(turnMessage().metadata);
    expect(meta).not.toBeNull();
    expect(meta?.summary).toContain('settings toggle');
    expect(meta?.manualTesting).toHaveLength(2);
    expect(meta?.summarySource).toBe('llm');
  });

  it('returns null for a different timeline kind', () => {
    expect(
      parseTurnChangeSummaryMetadata(JSON.stringify({ kind: 'finalize_run_summary' })),
    ).toBeNull();
  });

  it('returns null for malformed metadata', () => {
    expect(parseTurnChangeSummaryMetadata('not json')).toBeNull();
    expect(parseTurnChangeSummaryMetadata(null)).toBeNull();
  });

  it('drops non-string manual-testing entries', () => {
    const meta = parseTurnChangeSummaryMetadata(
      JSON.stringify({ kind: 'turn_change_summary', manualTesting: ['ok', 3, null, ''] }),
    );
    expect(meta?.manualTesting).toEqual(['ok']);
  });
});

describe('TurnChangeSummaryBlock', () => {
  it('renders the summary prose and manual-testing steps', () => {
    render(<TurnChangeSummaryBlock message={turnMessage()} />);
    expect(screen.getByTestId('turn-change-summary-block')).toBeTruthy();
    expect(screen.getByTestId('turn-change-summary-prose').textContent).toContain(
      'settings toggle',
    );
    expect(screen.getByText('Manual testing to perform')).toBeTruthy();
    expect(screen.getAllByTestId('turn-change-summary-manual-step')).toHaveLength(2);
  });

  it('hides the prose paragraph when there is no summary', () => {
    render(<TurnChangeSummaryBlock message={turnMessage({ summary: '' })} />);
    expect(screen.queryByTestId('turn-change-summary-prose')).toBeNull();
  });

  it('shows the empty-state copy when no manual-testing steps were generated', () => {
    render(<TurnChangeSummaryBlock message={turnMessage({ manualTesting: [] })} />);
    expect(screen.queryByTestId('turn-change-summary-manual-step')).toBeNull();
    expect(
      screen.getByText('No manual testing steps were generated for this change.'),
    ).toBeTruthy();
  });

  it('collapses the manual-testing section when the header is clicked', () => {
    render(<TurnChangeSummaryBlock message={turnMessage()} />);
    expect(screen.getAllByTestId('turn-change-summary-manual-step')).toHaveLength(2);
    fireEvent.click(screen.getByText('Manual testing to perform'));
    expect(screen.queryByTestId('turn-change-summary-manual-step')).toBeNull();
  });

  it('renders nothing for metadata that is not a turn-change summary', () => {
    const { container } = render(
      <TurnChangeSummaryBlock message={{ metadata: JSON.stringify({ kind: 'other' }) }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

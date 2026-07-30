import { NO_COMMITS_MESSAGE } from '@shared/utils/finalizeSummaryCopy';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FinalizeRunSummaryBlock from './FinalizeRunSummaryBlock';

function summaryMessage(payload: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    created_at: '2026-07-28T12:00:00Z',
    metadata: JSON.stringify({
      kind: 'finalize_run_summary',
      runId: 'run-1',
      round: 2,
      headSha: 'abc123',
      summary: 'Adds a widget to the settings page.',
      summarySource: 'llm',
      commits: ['Add widget', 'Fix review note'],
      truncatedCommits: 0,
      diffStat: ' client/src/a.tsx | 3 +++\n 1 file changed, 3 insertions(+)',
      filesChanged: 1,
      insertions: 3,
      deletions: 0,
      reviewRounds: [
        {
          round: 1,
          verdict: 'changes_requested',
          findings: [
            { filePath: 'server/a.ts', lineStart: 4, lineEnd: 9, body: 'guard the null case' },
          ],
          truncatedFindings: 0,
        },
        { round: 2, verdict: 'approved', findings: [], truncatedFindings: 0 },
      ],
      totalFindings: 1,
      finalVerdict: 'approved',
      reviewNotes: 'The reviewer asked for a null guard; it was added.',
      manualTesting: ['Open Settings and toggle the widget', 'Reload and confirm it persists'],
      ...payload,
    }),
  };
}

describe('FinalizeRunSummaryBlock', () => {
  it('renders the prose, the change list, the review findings, and the checklist', () => {
    render(<FinalizeRunSummaryBlock message={summaryMessage()} />);

    expect(screen.getByTestId('finalize-run-summary-block')).toBeInTheDocument();
    expect(screen.getByTestId('finalize-summary-prose')).toHaveTextContent(
      'Adds a widget to the settings page.',
    );

    expect(screen.getByTestId('finalize-summary-changes')).toHaveTextContent('Add widget');
    expect(screen.getByTestId('finalize-summary-diffstat')).toHaveTextContent('1 file');
    expect(screen.getByTestId('finalize-summary-diffstat')).toHaveTextContent('+3');

    expect(screen.getByTestId('finalize-summary-review')).toHaveTextContent(
      'The reviewer asked for a null guard',
    );
    const findings = screen.getAllByTestId('finalize-summary-finding');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toHaveTextContent('server/a.ts L4-9');
    expect(findings[0]).toHaveTextContent('guard the null case');

    expect(screen.getAllByTestId('finalize-summary-manual-step')).toHaveLength(2);
  });

  it('shows the final review verdict as a pill', () => {
    render(<FinalizeRunSummaryBlock message={summaryMessage()} />);
    const pill = screen.getByTestId('finalize-summary-verdict');
    expect(pill).toHaveAttribute('data-verdict', 'approved');
    expect(pill).toHaveTextContent('Review approved');
  });

  it('renders a file-level finding without a line anchor', () => {
    render(
      <FinalizeRunSummaryBlock
        message={summaryMessage({
          reviewRounds: [
            {
              round: 1,
              verdict: 'changes_requested',
              findings: [
                { filePath: 'server/a.ts', lineStart: null, lineEnd: null, body: 'whole file' },
              ],
              truncatedFindings: 0,
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('finalize-summary-finding')).toHaveTextContent(
      'server/a.ts file-level',
    );
  });

  it('states the empty case per section instead of hiding it', () => {
    render(
      <FinalizeRunSummaryBlock
        message={summaryMessage({
          summary: '',
          commits: [],
          diffStat: '',
          filesChanged: null,
          insertions: null,
          deletions: null,
          reviewRounds: [],
          totalFindings: 0,
          finalVerdict: null,
          reviewNotes: '',
          manualTesting: [],
        })}
      />,
    );

    expect(screen.queryByTestId('finalize-summary-prose')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finalize-summary-verdict')).not.toBeInTheDocument();
    expect(screen.getByTestId('finalize-summary-changes')).toHaveTextContent(NO_COMMITS_MESSAGE);
    expect(screen.getByTestId('finalize-summary-review')).toHaveTextContent(
      'No review rounds recorded for this run.',
    );
    expect(screen.getByTestId('finalize-summary-manual-testing')).toHaveTextContent(
      'No manual testing steps were generated',
    );
  });

  it('says so explicitly when the reviewer raised nothing across its rounds', () => {
    render(
      <FinalizeRunSummaryBlock
        message={summaryMessage({
          reviewRounds: [{ round: 1, verdict: 'approved', findings: [], truncatedFindings: 0 }],
          totalFindings: 0,
          reviewNotes: '',
        })}
      />,
    );

    expect(screen.getByTestId('finalize-summary-review')).toHaveTextContent(
      'The reviewer raised nothing across 1 round.',
    );
    expect(screen.queryByTestId('finalize-summary-finding')).not.toBeInTheDocument();
  });

  it('reads server-shaped (flat) metadata, not a nested payload', () => {
    // The server writes JSON.stringify({ kind, ...payload }) — every field is
    // top-level. This pins that contract from the consumer side: a reviewer
    // reading the server's `{ kind, payload }` parser could reasonably assume
    // the fields are nested, "fix" the client parser to read parsed.payload.*,
    // and silently ship an empty summary card. Both halves are asserted so the
    // wrong shape can never look right.
    const flat = JSON.stringify({
      kind: 'finalize_run_summary',
      runId: 'run-1',
      summary: 'Flat fields are the contract.',
      commits: ['Add widget'],
      totalFindings: 1,
      finalVerdict: 'approved',
      manualTesting: ['Check the page'],
      reviewRounds: [
        {
          round: 1,
          verdict: 'changes_requested',
          findings: [{ filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: 'nit' }],
          truncatedFindings: 0,
        },
      ],
    });
    const { unmount } = render(<FinalizeRunSummaryBlock message={{ id: 'm3', metadata: flat }} />);
    expect(screen.getByTestId('finalize-summary-prose')).toHaveTextContent(
      'Flat fields are the contract.',
    );
    expect(screen.getByTestId('finalize-summary-changes')).toHaveTextContent('Add widget');
    expect(screen.getByTestId('finalize-summary-finding')).toHaveTextContent('nit');
    expect(screen.getByTestId('finalize-summary-verdict')).toHaveAttribute(
      'data-verdict',
      'approved',
    );
    expect(screen.getAllByTestId('finalize-summary-manual-step')).toHaveLength(1);
    unmount();

    // The shape the server does NOT write. If this ever starts populating, the
    // writer changed and the parser must be revisited deliberately.
    const nested = JSON.stringify({
      kind: 'finalize_run_summary',
      payload: { runId: 'run-1', summary: 'nested', commits: ['Add widget'] },
    });
    render(<FinalizeRunSummaryBlock message={{ id: 'm4', metadata: nested }} />);
    expect(screen.queryByTestId('finalize-summary-prose')).not.toBeInTheDocument();
    expect(screen.getByTestId('finalize-summary-changes')).toHaveTextContent(NO_COMMITS_MESSAGE);
  });

  it('renders nothing for a message that is not a run summary', () => {
    const { container } = render(
      <FinalizeRunSummaryBlock
        message={{ id: 'm2', metadata: JSON.stringify({ kind: 'finalize_run_terminal' }) }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { QaResultWire } from '../utils/api';

const fetchArtifactBlob = vi.fn<(sessionId: string, artifactId: string) => Promise<Blob>>();
vi.mock('../utils/artifactContent', () => ({
  fetchArtifactBlob: (s: string, a: string) => fetchArtifactBlob(s, a),
}));

import QaRunResults, { orderRunResults } from './QaRunResults';

function result(caseId: string, extra: Partial<QaResultWire> = {}): QaResultWire {
  return {
    id: `res-${caseId}`,
    runId: 'r1',
    caseId,
    caseVersion: 1,
    verdict: 'pass',
    actual: '',
    notes: '',
    screenshotArtifactIds: [],
    screenshots: [],
    findingCardId: null,
    createdAt: '2026-10-26 10:00:00',
    updatedAt: '2026-10-26 10:00:00',
    ...extra,
  };
}

const cases = [
  { id: 'a', title: 'Login', expected: 'Dashboard loads', version: 1 },
  { id: 'b', title: 'Pay', expected: 'Receipt shown', version: 2 },
];

beforeEach(() => {
  fetchArtifactBlob.mockReset();
  fetchArtifactBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:shot');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('orderRunResults', () => {
  it('orders by case and keeps results for deleted cases at the end', () => {
    const rows = orderRunResults([result('gone'), result('b'), result('a')], cases);
    expect(rows.map((r) => [r.result.caseId, r.qaCase?.title ?? null])).toEqual([
      ['a', 'Login'],
      ['b', 'Pay'],
      ['gone', null],
    ]);
  });
});

describe('QaRunResults', () => {
  it('shows verdict, expected vs actual, notes, the finding card, and a stale-version flag', () => {
    const onOpenCard = vi.fn();
    render(
      <QaRunResults
        run={{
          id: 'r1',
          sessionId: 's1',
          results: [
            result('b', {
              verdict: 'fail',
              actual: 'Spinner never stops',
              notes: 'Console shows a 500',
              findingCardId: 'card-1',
            }),
          ],
        }}
        cases={cases}
        onOpenCard={onOpenCard}
      />,
    );
    const row = screen.getByTestId('qa-result-b');
    expect(within(row).getByTestId('qa-result-verdict').textContent).toBe('fail');
    expect(within(row).getByText('Receipt shown')).toBeTruthy();
    expect(within(row).getByText('Spinner never stops')).toBeTruthy();
    expect(within(row).getByText('Console shows a 500')).toBeTruthy();
    expect(within(row).getByText('recorded against v1')).toBeTruthy();
    fireEvent.click(within(row).getByTestId('qa-result-finding'));
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
  });

  it('renders screenshot thumbnails and opens one in the artifact viewer', async () => {
    render(
      <QaRunResults
        run={{
          id: 'r1',
          sessionId: 's1',
          results: [
            result('a', {
              screenshotArtifactIds: ['art-1'],
              screenshots: [{ id: 'art-1', filename: 'login.png', contentType: 'image/png' }],
            }),
          ],
        }}
        cases={cases}
      />,
    );
    const thumb = screen.getByTestId('qa-screenshot-art-1');
    await waitFor(() => expect(within(thumb).getByRole('img')).toBeTruthy());
    expect(fetchArtifactBlob).toHaveBeenCalledWith('s1', 'art-1');

    fireEvent.click(thumb);
    const viewer = screen.getByTestId('qa-screenshot-viewer');
    expect(within(viewer).getByText('login.png')).toBeTruthy();
    await waitFor(() =>
      expect(within(viewer).getByTestId('session-artifact-viewer-image')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('qa-screenshot-viewer-close'));
    expect(screen.queryByTestId('qa-screenshot-viewer')).toBeNull();
  });

  it('renders a screenshot stored as a generic .dat blob once the server serves an image type', async () => {
    render(
      <QaRunResults
        run={{
          id: 'r1',
          sessionId: 's1',
          results: [
            result('a', {
              screenshotArtifactIds: ['art-2'],
              screenshots: [
                {
                  id: 'art-2',
                  filename: 'case 1: page loaded.dat',
                  contentType: 'application/octet-stream',
                },
              ],
            }),
          ],
        }}
        cases={cases}
      />,
    );
    const thumb = screen.getByTestId('qa-screenshot-art-2');
    await waitFor(() => expect(within(thumb).getByRole('img')).toBeTruthy());
    expect(fetchArtifactBlob).toHaveBeenCalledWith('s1', 'art-2');

    fireEvent.click(thumb);
    const viewer = screen.getByTestId('qa-screenshot-viewer');
    await waitFor(() =>
      expect(within(viewer).getByTestId('session-artifact-viewer-image')).toBeTruthy(),
    );
  });

  it('keeps the filename tile when a generic blob is not an image', async () => {
    fetchArtifactBlob.mockResolvedValue(new Blob(['x'], { type: 'application/octet-stream' }));
    render(
      <QaRunResults
        run={{
          id: 'r1',
          sessionId: 's1',
          results: [
            result('a', {
              screenshotArtifactIds: ['art-3'],
              screenshots: [
                { id: 'art-3', filename: 'notes.dat', contentType: 'application/octet-stream' },
              ],
            }),
          ],
        }}
        cases={cases}
      />,
    );
    const thumb = screen.getByTestId('qa-screenshot-art-3');
    await waitFor(() => expect(fetchArtifactBlob).toHaveBeenCalledWith('s1', 'art-3'));
    expect(within(thumb).queryByRole('img')).toBeNull();
    expect(within(thumb).getByText('notes.dat')).toBeTruthy();
  });

  it('says so when a run has no results', () => {
    render(<QaRunResults run={{ id: 'r1', sessionId: 's1', results: [] }} cases={cases} />);
    expect(screen.getByTestId('qa-run-results-empty')).toBeTruthy();
  });
});

describe('QaRunResults troubleshoot', () => {
  const run = {
    id: 'r1',
    sessionId: 's1',
    results: [
      result('a', { verdict: 'pass' }),
      result('b', { verdict: 'blocked' }),
      result('gone', { verdict: 'fail' }),
    ],
  };

  it('offers Troubleshoot only on failed or blocked results for cases still on the plan', () => {
    render(<QaRunResults run={run} cases={cases} onTroubleshoot={vi.fn()} />);
    expect(
      within(screen.getByTestId('qa-result-a')).queryByTestId('qa-result-troubleshoot'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('qa-result-b')).getByTestId('qa-result-troubleshoot'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('qa-result-gone')).queryByTestId('qa-result-troubleshoot'),
    ).toBeNull();
  });

  it('hides the button when no handler is given', () => {
    render(<QaRunResults run={run} cases={cases} />);
    expect(screen.queryByTestId('qa-result-troubleshoot')).toBeNull();
  });

  it('calls the handler with the case id and shows a failure inline', async () => {
    const onTroubleshoot = vi.fn().mockRejectedValue(new Error('No dev agent'));
    render(<QaRunResults run={run} cases={cases} onTroubleshoot={onTroubleshoot} />);
    fireEvent.click(screen.getByTestId('qa-result-troubleshoot'));
    expect(onTroubleshoot).toHaveBeenCalledWith('b');
    await waitFor(() =>
      expect(screen.getByTestId('qa-result-troubleshoot-error').textContent).toBe('No dev agent'),
    );
  });
});

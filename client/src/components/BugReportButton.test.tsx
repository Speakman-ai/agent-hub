import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BugReportButton from './BugReportButton';
import { captureScreenshot } from '../utils/bugReport';

vi.mock('../utils/bugReport', () => ({
  captureScreenshot: vi.fn(),
}));

vi.mock('./BugReportModal', () => ({
  default: (props: any) =>
    props.isOpen ? (
      <div
        data-testid="bug-report-modal"
        data-screenshot-miss-reason={props.initialScreenshotMissReason || ''}
      />
    ) : null,
}));

describe('BugReportButton', () => {
  beforeEach(() => {
    vi.mocked(captureScreenshot).mockReset();
  });

  it('opens the modal with a screenshot miss reason when initial capture fails', async () => {
    vi.mocked(captureScreenshot).mockRejectedValueOnce(new Error('html2canvas failed'));

    render(<BugReportButton projectId="agent-hub" agentId="agent-hub-dev" />);

    fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));

    await waitFor(() => expect(screen.getByTestId('bug-report-modal')).toBeInTheDocument());
    expect(screen.getByTestId('bug-report-modal')).toHaveAttribute(
      'data-screenshot-miss-reason',
      'initial-capture-failed',
    );
  });
});

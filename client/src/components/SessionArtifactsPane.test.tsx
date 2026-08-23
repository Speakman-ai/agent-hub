import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getSessionArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
  fetchArtifactBlob: vi.fn().mockResolvedValue(new Blob(['# Generated report'])),
}));

vi.mock('../utils/api', () => ({
  api: {
    getSessionArtifacts: mocks.getSessionArtifacts,
    deleteSessionArtifact: vi.fn(),
  },
}));

vi.mock('../utils/artifactContent', () => ({
  fetchArtifactBlob: mocks.fetchArtifactBlob,
  downloadArtifact: vi.fn(),
}));

vi.mock('./MarkdownRenderer', () => ({
  MarkdownContent: ({ content }: any) => <div data-testid="mock-markdown">{content}</div>,
  markdownComponentsCompact: {},
}));

import SessionArtifactsPane from './SessionArtifactsPane';

const presentedArtifact = {
  id: 'artifact-1',
  filename: 'generated-report.md',
  contentType: 'text/markdown',
  size: 18,
};

describe('SessionArtifactsPane inline presentation', () => {
  it('opens a newly presented artifact directly in the in-session viewer', async () => {
    const onPresentedArtifact = vi.fn();
    render(
      <SessionArtifactsPane
        sessionId="session-1"
        presentedArtifact={presentedArtifact}
        onPresentedArtifact={onPresentedArtifact}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('generated-report.md')).toBeInTheDocument();
    expect(screen.getByText('Artifact preview')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('mock-markdown')).toHaveTextContent('# Generated report'),
    );
    expect(mocks.fetchArtifactBlob).toHaveBeenCalledWith('session-1', 'artifact-1');
    expect(onPresentedArtifact).toHaveBeenCalledWith('session-1', 'artifact-1');
  });

  it('returns to the artifact list without closing the session pane', async () => {
    render(
      <SessionArtifactsPane
        sessionId="session-1"
        presentedArtifact={presentedArtifact}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('session-artifact-viewer-back'));
    await waitFor(() => expect(screen.getByText('Artifacts')).toBeInTheDocument());
    expect(screen.queryByText('Artifact preview')).not.toBeInTheDocument();
  });
});

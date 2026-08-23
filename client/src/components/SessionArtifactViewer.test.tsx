import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchArtifactBlob: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('../utils/artifactContent', () => ({
  fetchArtifactBlob: mocks.fetchArtifactBlob,
}));
vi.mock('./MarkdownRenderer', () => ({
  MarkdownContent: ({ content }: any) => <div>{content}</div>,
  markdownComponentsCompact: {},
}));

import SessionArtifactViewer from './SessionArtifactViewer';

describe('SessionArtifactViewer render failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchArtifactBlob.mockResolvedValue(new Blob(['not actually an image']));
    mocks.createObjectURL.mockReturnValue('blob:artifact-preview');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mocks.createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mocks.revokeObjectURL,
    });
  });

  it('replaces an undecodable image with an actionable error and releases its object URL', async () => {
    render(
      <SessionArtifactViewer
        sessionId="session-1"
        artifact={{ id: 'artifact-1', filename: 'chart.png', contentType: 'image/png' }}
      />,
    );

    const image = await screen.findByTestId('session-artifact-viewer-image');
    fireEvent.error(image);

    expect(await screen.findByTestId('session-artifact-viewer-error')).toHaveTextContent(
      'Could not display this image. Download the file to inspect it.',
    );
    expect(screen.queryByTestId('session-artifact-viewer-image')).not.toBeInTheDocument();
    expect(mocks.revokeObjectURL).toHaveBeenCalledOnce();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:artifact-preview');
    expect(mocks.fetchArtifactBlob).toHaveBeenCalledWith('session-1', 'artifact-1');
  });
});

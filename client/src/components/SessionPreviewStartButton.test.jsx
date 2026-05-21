import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionPreviewStartButton from './SessionPreviewStartButton.jsx';

const configuredProject = {
  id: 'p1',
  prEnv: {
    preview: {
      enabled: true,
      compose: { entryService: 'web', entryPort: 5173 },
    },
  },
};

describe('SessionPreviewStartButton', () => {
  it('shows Configure preview when project is not configured', () => {
    const onConfigure = vi.fn();
    render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={{ id: 'p1', prEnv: { preview: { enabled: false } } }}
        onConfigure={onConfigure}
      />,
    );
    fireEvent.click(screen.getByTestId('session-preview-configure-button'));
    expect(onConfigure).toHaveBeenCalled();
  });

  it('calls onStart when preview is configured', () => {
    const onStart = vi.fn();
    render(
      <SessionPreviewStartButton sessionId="s1" project={configuredProject} onStart={onStart} />,
    );
    fireEvent.click(screen.getByTestId('session-start-preview-button'));
    expect(onStart).toHaveBeenCalledWith('s1');
  });
});

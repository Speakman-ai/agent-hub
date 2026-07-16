import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionPreviewStartButton from './SessionPreviewStartButton';

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
    fireEvent.click(screen.getByTestId('session-preview-configure-button' as any) as any);
    expect(onConfigure!).toHaveBeenCalled();
  });

  it('calls onStart when preview is configured', () => {
    const onStart = vi.fn();
    render(
      <SessionPreviewStartButton sessionId="s1" project={configuredProject} onStart={onStart} />,
    );
    fireEvent.click(screen.getByTestId('session-start-preview-button' as any) as any);
    expect(onStart!).toHaveBeenCalledWith('s1');
  });

  // Regression: a project configured via the dev-server process model
  // (`prEnv.devServer`, no compose block) must show Start preview, not
  // Configure preview. The server gate treats any devServer with a
  // startCommand as configured; the button must agree.
  it('shows Start preview for a dev-server-configured project (no compose block)', () => {
    const onStart = vi.fn();
    const devServerProject = {
      id: 'p1',
      prEnv: {
        preview: { enabled: true },
        devServer: {
          startCommand: './quickstart',
          portMap: [{ internalPort: 4200, label: 'web', primary: true }],
        },
      },
    };
    render(
      <SessionPreviewStartButton sessionId="s1" project={devServerProject} onStart={onStart} />,
    );
    fireEvent.click(screen.getByTestId('session-start-preview-button' as any) as any);
    expect(onStart!).toHaveBeenCalledWith('s1');
  });

  // Regression: the start/configure controls must remain reachable on mobile.
  // A `hidden` (display:none until the `sm` breakpoint) class removes the only
  // way to start or configure a preview from the chat action bar on phones.
  it('does not hide the Start preview button on mobile', () => {
    render(
      <SessionPreviewStartButton sessionId="s1" project={configuredProject} onStart={vi.fn()} />,
    );
    expect(screen.getByTestId('session-start-preview-button').classList.contains('hidden')).toBe(
      false,
    );
  });

  it('does not hide the Configure preview button on mobile', () => {
    render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={{ id: 'p1', prEnv: { preview: { enabled: false } } }}
        onConfigure={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('session-preview-configure-button').classList.contains('hidden'),
    ).toBe(false);
  });
});

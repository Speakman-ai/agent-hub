import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionPreviewStartButton from './SessionPreviewStartButton';

const configuredProject = {
  id: 'p1',
  prEnv: {
    devServer: { startCommand: 'npm run dev' },
  },
};

describe('SessionPreviewStartButton', () => {
  it('shows Configure preview when project is not configured', () => {
    const onConfigure = vi.fn();
    render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={{ id: 'p1', prEnv: {} }}
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
    expect(onStart!).toHaveBeenCalledWith('s1', 'rebuild');
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
    expect(onStart!).toHaveBeenCalledWith('s1', 'rebuild');
  });

  // A running preview WITHOUT a build command stays a single button — the
  // Rebuild/Restart split would be meaningless (both just re-run startCommand).
  it('keeps a single Restart button when running with no build command', () => {
    render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={configuredProject}
        previewEvent={{ kind: 'preview' }}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-start-preview-button')).toHaveTextContent('Restart preview');
    expect(screen.queryByTestId('session-restart-preview-menu-button')).toBeNull();
  });

  // A running preview WITH a build command splits into a Rebuild/Restart menu.
  it('splits into a Rebuild App / Restart Server menu when running with a build command', () => {
    const onStart = vi.fn();
    const buildProject = {
      id: 'p1',
      prEnv: { devServer: { startCommand: 'npm run serve', buildCommand: 'npm run build' } },
    };
    render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={buildProject}
        previewEvent={{ kind: 'preview' }}
        onStart={onStart}
      />,
    );
    // Menu is closed until the split button is clicked.
    expect(screen.queryByTestId('session-preview-rebuild-app')).toBeNull();
    fireEvent.click(screen.getByTestId('session-restart-preview-menu-button'));

    fireEvent.click(screen.getByTestId('session-preview-restart-server'));
    expect(onStart).toHaveBeenCalledWith('s1', 'restart-server');

    // Re-open and pick Rebuild App.
    fireEvent.click(screen.getByTestId('session-restart-preview-menu-button'));
    fireEvent.click(screen.getByTestId('session-preview-rebuild-app'));
    expect(onStart).toHaveBeenCalledWith('s1', 'rebuild');
  });

  // Regression: the production caller is `variant="menu"` inside the
  // `overflow-y-auto` Actions dropdown. The flyout must render in-flow there
  // (not an `absolute top-full` overlay the scrollbox clips) and must NOT drop
  // a `fixed inset-0` backdrop that would swallow clicks on the rest of the menu.
  it('renders the running split menu in-flow (no overlay/backdrop) in the menu variant', () => {
    const onStart = vi.fn();
    const buildProject = {
      id: 'p1',
      prEnv: { devServer: { startCommand: 'npm run serve', buildCommand: 'npm run build' } },
    };
    const { container } = render(
      <SessionPreviewStartButton
        sessionId="s1"
        project={buildProject}
        previewEvent={{ kind: 'preview' }}
        onStart={onStart}
        variant="menu"
      />,
    );
    fireEvent.click(screen.getByTestId('session-restart-preview-menu-button'));

    const flyout = screen.getByRole('menu');
    // In-flow submenu class (SESSION_ACTION_SUBMENU_CLASS), not an absolute overlay.
    expect(flyout.className).toContain('w-full');
    expect(flyout.className).not.toContain('absolute');
    // No screen-covering backdrop that would eat clicks on sibling menu rows.
    expect(container.querySelector('.fixed.inset-0')).toBeNull();

    fireEvent.click(screen.getByTestId('session-preview-restart-server'));
    expect(onStart).toHaveBeenCalledWith('s1', 'restart-server');
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
        project={{ id: 'p1', prEnv: {} }}
        onConfigure={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('session-preview-configure-button').classList.contains('hidden'),
    ).toBe(false);
  });
});

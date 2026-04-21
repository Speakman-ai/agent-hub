import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub BugReportButton — its transitive dynamic import of html2canvas fails to
// resolve under vitest's import-analysis pass (pre-existing across the suite).
vi.mock('./BugReportButton.jsx', () => ({
  default: () => null,
}));

const TopBar = (await import('./TopBar.jsx')).default;

const baseAgent = {
  id: 'agent-1',
  name: 'Hub Frontend',
  color: '#8B5CF6',
  cwd: '/tmp/agent-hub',
};

function renderTopBar(overrides = {}) {
  const props = {
    agent: baseAgent,
    connected: true,
    reconnecting: false,
    onNewSession: () => {},
    onNavigate: () => {},
    onToggleSidebar: () => {},
    sessionEngine: 'claude-code',
    onEngineChange: vi.fn(),
    sessionModel: 'claude-opus-4-7',
    onModelChange: vi.fn(),
    messages: [],
    activeSessionId: 'session-1',
    sessionWorktree: false,
    gitWorktreeDetected: null,
    onWorktreeChange: () => {},
    sessionAskMode: false,
    onAskModeChange: () => {},
    verboseMode: false,
    onVerboseModeChange: () => {},
    projectId: 'proj-a',
    showToast: () => {},
    onOpenForward: () => {},
    canForward: false,
    ...overrides,
  };
  const utils = render(<TopBar {...props} />);
  return { ...utils, props };
}

describe('<TopBar /> engine picker', () => {
  it('renders the current engine label in the dropdown trigger', () => {
    renderTopBar({ sessionEngine: 'claude-code' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect(trigger.textContent).toMatch(/Claude Code/);
  });

  it('opens the engine dropdown and calls onEngineChange with gemini-cli', () => {
    const onEngineChange = vi.fn();
    renderTopBar({ sessionEngine: 'claude-code', onEngineChange });

    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger);

    // Both engine options should now be visible in the dropdown
    expect(screen.getByText('Gemini CLI')).toBeTruthy();

    fireEvent.click(screen.getByText('Gemini CLI'));
    expect(onEngineChange).toHaveBeenCalledWith('gemini-cli');
  });

  it('reflects gemini-cli as the active engine when selected', () => {
    renderTopBar({ sessionEngine: 'gemini-cli', sessionModel: 'gemini-2.5-pro' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect(trigger.textContent).toMatch(/Gemini CLI/);

    fireEvent.click(trigger);
    // Active option should have the checkmark
    const geminiOption = screen
      .getAllByRole('button')
      .find((b) => b.textContent.includes('Gemini CLI') && b.textContent.includes('✓'));
    expect(geminiOption).toBeTruthy();
  });
});

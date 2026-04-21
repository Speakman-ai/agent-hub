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

  it('opens the engine dropdown and calls onEngineChange with cursor-agent', () => {
    const onEngineChange = vi.fn();
    renderTopBar({ sessionEngine: 'claude-code', onEngineChange });

    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger);

    // Both engine options should now be visible in the dropdown
    expect(screen.getByText('Cursor Agent')).toBeTruthy();

    fireEvent.click(screen.getByText('Cursor Agent'));
    expect(onEngineChange).toHaveBeenCalledWith('cursor-agent');
  });

  it('reflects cursor-agent as the active engine when selected', () => {
    renderTopBar({ sessionEngine: 'cursor-agent', sessionModel: 'composer-2' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect(trigger.textContent).toMatch(/Cursor Agent/);

    fireEvent.click(trigger);
    // Active option should have the checkmark
    const cursorOption = screen
      .getAllByRole('button')
      .find((b) => b.textContent.includes('Cursor Agent') && b.textContent.includes('✓'));
    expect(cursorOption).toBeTruthy();
  });

  it('does not list Gemini CLI as an engine option', () => {
    renderTopBar({ sessionEngine: 'claude-code' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger);
    expect(screen.queryByText('Gemini CLI')).toBeNull();
  });

  it('lists Codex as a selectable engine option and calls onEngineChange with codex-cli', () => {
    const onEngineChange = vi.fn();
    renderTopBar({ sessionEngine: 'claude-code', onEngineChange });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger);

    // Use getAllByText since "Codex" can appear in the dropdown plus any
    // model-preview text — we only care that at least one option is clickable.
    const codexOption = screen
      .getAllByRole('button')
      .find(
        (b) => /^\s*Codex(\s|$)/.test(b.textContent || '') && !b.textContent.includes('Model:'),
      );
    expect(codexOption).toBeTruthy();
    fireEvent.click(codexOption);
    expect(onEngineChange).toHaveBeenCalledWith('codex-cli');
  });

  it('reflects codex-cli as the active engine and shows gpt-5.2-codex as the default model', () => {
    renderTopBar({ sessionEngine: 'codex-cli', sessionModel: 'gpt-5.2-codex' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect(trigger.textContent).toMatch(/Codex/);

    const modelTrigger = screen.getByTitle(/^Model: /);
    fireEvent.click(modelTrigger);
    // All allowlisted Codex models should be visible in the picker
    expect(screen.getAllByText(/GPT-5.2 Codex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPT-5.1 Codex Max/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPT-5 Codex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^GPT-5$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPT-5 Mini/).length).toBeGreaterThan(0);
  });

  it('shows only composer-2 as the model for cursor-agent', () => {
    renderTopBar({ sessionEngine: 'cursor-agent', sessionModel: 'composer-2' });
    // The model trigger surfaces by its title attribute
    const modelTrigger = screen.getByTitle(/^Model: /);
    fireEvent.click(modelTrigger);
    expect(screen.getAllByText('Composer 2').length).toBeGreaterThan(0);
    // No other cursor models (Codex variants, auto, composer-2-fast) should be rendered
    expect(screen.queryByText(/GPT-5.2 Codex/)).toBeNull();
    expect(screen.queryByText(/Composer 2 Fast/)).toBeNull();
    expect(screen.queryByText(/^Auto$/)).toBeNull();
  });
});

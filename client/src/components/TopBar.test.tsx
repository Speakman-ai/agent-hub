import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const TopBar = (await import('./TopBar')).default;

const baseAgent = {
  id: 'agent-1',
  name: 'Hub Frontend',
  color: '#8B5CF6',
  cwd: '/tmp/agent-hub',
};

function renderTopBar(overrides: any = {}) {
  const props = {
    agent: baseAgent,
    onNewSession: () => {},
    onToggleSidebar: () => {},
    sessionEngine: 'claude-code',
    onEngineChange: vi.fn(),
    sessionModel: 'claude-opus-4-8',
    onModelChange: vi.fn(),
    messages: [],
    activeSessionId: 'session-1',
    activeSessionState: 'reviewing',
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
  it('does not render the Ask/Agent mode toggle (removed from the top bar)', () => {
    renderTopBar();
    // The toggle was the only control with an "Ask mode: …" title.
    expect(screen.queryByTitle(/Ask mode/i)).toBeNull();
  });

  it('renders the active session lifecycle icon in the header', () => {
    renderTopBar();
    expect(screen.getByTestId('topbar-session-state-icon')).toHaveAttribute(
      'data-session-state',
      'reviewing',
    );
  });

  it('renders the active session id truncated in the header', () => {
    renderTopBar({ activeSessionId: 'session-debug-123' });
    const sessionId = screen.getByTestId('topbar-session-id');
    expect((sessionId as any).textContent).toContain('Session');
    expect((sessionId as any).textContent).toContain('…ebug-123');
    expect((sessionId as any).textContent).not.toContain('session-debug-123');
    expect(sessionId!).toHaveAttribute('title', 'Copy session id: session-debug-123');
  });

  it('hides the session lifecycle icon when no session is active', () => {
    renderTopBar({ activeSessionId: null });
    expect(screen.queryByTestId('topbar-session-state-icon')).toBeNull();
  });

  it('renders the current engine label in the dropdown trigger', () => {
    renderTopBar({ sessionEngine: 'claude-code' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect((trigger as any).textContent).toMatch(/Claude Code/);
  });

  it('opens the engine dropdown and calls onEngineChange with cursor-agent', () => {
    const onEngineChange = vi.fn();
    renderTopBar({ sessionEngine: 'claude-code', onEngineChange });

    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger as any);

    // Both engine options should now be visible in the dropdown
    expect(screen.getByText('Cursor Agent')).toBeTruthy();

    fireEvent.click(screen.getByText('Cursor Agent' as any) as any);
    expect(onEngineChange!).toHaveBeenCalledWith('cursor-agent');
  });

  it('reflects cursor-agent as the active engine when selected', () => {
    renderTopBar({ sessionEngine: 'cursor-agent', sessionModel: 'composer-2.5' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect((trigger as any).textContent).toMatch(/Cursor Agent/);

    fireEvent.click(trigger as any);
    // Active option should have the checkmark
    const cursorOption = screen
      .getAllByRole('button')
      .find(
        (b: any) =>
          (b as any).textContent.includes('Cursor Agent') && (b as any).textContent.includes('✓'),
      );
    expect(cursorOption!).toBeTruthy();
  });

  it('hides engines with no authenticated models when modelConfig is provided', () => {
    renderTopBar({
      sessionEngine: 'claude-code',
      modelConfig: {
        defaultModel: 'claude-opus-4-8',
        engineDefaultModels: {
          'claude-code': 'claude-opus-4-8',
          'cursor-agent': '',
          'codex-cli': '',
        },
        engineValidModels: {
          'claude-code': ['claude-opus-4-8'],
          'cursor-agent': [],
          'codex-cli': [],
        },
      },
    });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger as any);
    expect(screen.queryByText('Cursor Agent')).toBeNull();
    expect(screen.queryByText(/^Codex$/)).toBeNull();
    // Engine label appears on the trigger and again inside the open dropdown.
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
  });

  it('does not list Gemini CLI as an engine option', () => {
    renderTopBar({ sessionEngine: 'claude-code' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger as any);
    expect(screen.queryByText('Gemini CLI')).toBeNull();
  });

  it('lists Codex as a selectable engine option and calls onEngineChange with codex-cli', () => {
    const onEngineChange = vi.fn();
    renderTopBar({ sessionEngine: 'claude-code', onEngineChange });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    fireEvent.click(trigger as any);

    // Use getAllByText since "Codex" can appear in the dropdown plus any
    // model-preview text — we only care that at least one option is clickable.
    const codexOption = screen
      .getAllByRole('button')
      .find(
        (b: any) =>
          /^\s*Codex(\s|$)/.test((b as any).textContent || '') &&
          !(b as any).textContent.includes('Model:'),
      );
    expect(codexOption!).toBeTruthy();
    fireEvent.click(codexOption as any);
    expect(onEngineChange!).toHaveBeenCalledWith('codex-cli');
  });

  it('reflects codex-cli as the active engine and exposes only ChatGPT-accepted models', () => {
    // Regression: previously the Codex dropdown offered gpt-5, gpt-5-mini,
    // gpt-5-codex, gpt-5.2-codex, and gpt-5.1-codex-max — all rejected with
    // HTTP 400 under ChatGPT OAuth. The current allowlist must only offer
    // models the ChatGPT backend accepts. As of June 2026 gpt-5.3-codex is
    // also no longer accepted under ChatGPT OAuth, and as of July 2026 gpt-5.6
    // is likewise rejected (and unknown to the installed codex-cli) — neither
    // must be selectable. Keep in sync with server/config.ts →
    // engineValidModels['codex-cli'].
    renderTopBar({ sessionEngine: 'codex-cli', sessionModel: 'gpt-5.5' });
    const trigger = screen.getByRole('button', { name: /select engine/i });
    expect((trigger as any).textContent).toMatch(/Codex/);

    const modelTrigger = screen.getByTitle(/^Model: /);
    fireEvent.click(modelTrigger as any);
    // Present:
    expect(screen.getAllByText(/^GPT-5.5$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^GPT-5.4$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GPT-5.4 Mini/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^GPT-5.2$/).length).toBeGreaterThan(0);
    // Absent (deprecated / rejected under ChatGPT OAuth):
    expect(screen.queryByText(/^GPT-5.6$/)).toBeNull();
    expect(screen.queryByText(/GPT-5.3 Codex/)).toBeNull();
    expect(screen.queryByText(/GPT-5.2 Codex/)).toBeNull();
    expect(screen.queryByText(/GPT-5.1 Codex Max/)).toBeNull();
    expect(screen.queryByText(/^GPT-5 Codex$/)).toBeNull();
    expect(screen.queryByText(/^GPT-5$/)).toBeNull();
    expect(screen.queryByText(/GPT-5 Mini/)).toBeNull();
  });

  it('shows only composer-2.5 as the model for cursor-agent', () => {
    renderTopBar({ sessionEngine: 'cursor-agent', sessionModel: 'composer-2.5' });
    // The model trigger surfaces by its title attribute
    const modelTrigger = screen.getByTitle(/^Model: /);
    fireEvent.click(modelTrigger as any);
    expect(screen.getAllByText('Composer 2.5').length).toBeGreaterThan(0);
    // No other cursor models (Codex variants, auto, composer-2-fast, legacy
    // composer-2) should be rendered.
    expect(screen.queryByText(/GPT-5.3 Codex/)).toBeNull();
    expect(screen.queryByText(/Composer 2 Fast/)).toBeNull();
    expect(screen.queryByText(/^Composer 2$/)).toBeNull();
    expect(screen.queryByText(/^Auto$/)).toBeNull();
  });
});

describe('<TopBar /> reviewer-agent "+ New" gating', () => {
  it('renders the "+ New" button for non-reviewer agents', () => {
    renderTopBar({ agent: { ...baseAgent, role: 'lead' } });
    expect(screen.getByRole('button', { name: '+ New' })).toBeTruthy();
  });

  it('hides the "+ New" button when the active agent has role=reviewer', () => {
    renderTopBar({ agent: { ...baseAgent, role: 'reviewer' } });
    // The "+ New" button is the only button whose visible label is "+ New".
    expect(screen.queryByRole('button', { name: '+ New' })).toBeNull();
  });

  it('calls onNewSession when the "+ New" button is clicked', () => {
    const onNewSession = vi.fn();
    renderTopBar({ agent: { ...baseAgent, role: 'lead' }, onNewSession });
    fireEvent.click(screen.getByRole('button', { name: '+ New' } as any) as any);
    expect(onNewSession!).toHaveBeenCalledTimes(1);
  });
});

describe('<TopBar /> accent color', () => {
  it('uses accentColor for the header dot and border when provided', () => {
    const { container } = renderTopBar({
      accentColor: '#10B981',
      agent: { ...baseAgent, color: '#8B5CF6' },
    });
    const header = container.firstChild;
    expect((header as any).style.borderBottomColor).toBe('rgb(16, 185, 129)');
    const dot = container.querySelector('.rounded-full');
    expect((dot as any).style.backgroundColor).toBe('rgb(16, 185, 129)');
  });
});

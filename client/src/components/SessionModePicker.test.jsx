import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SessionModePicker from './SessionModePicker.jsx';

/**
 * SessionModePicker — the Chat | Design segmented control. It is presentational:
 * the parent owns `mode` and persists changes in `onChange`. The behaviour worth
 * locking down is exactly the contract the server enforces (no Design without a
 * worktree) plus the don't-fire-on-noop guard.
 */
describe('SessionModePicker', () => {
  it('renders both Chat and Design options', () => {
    render(<SessionModePicker mode="chat" canDesign onChange={vi.fn()} />);
    expect(screen.getByTestId('session-mode-picker')).toBeInTheDocument();
    expect(screen.getByTestId('session-mode-chat')).toBeInTheDocument();
    expect(screen.getByTestId('session-mode-design')).toBeInTheDocument();
  });

  it('marks the current mode as pressed', () => {
    render(<SessionModePicker mode="design" canDesign onChange={vi.fn()} />);
    expect(screen.getByTestId('session-mode-design')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('session-mode-chat')).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires onChange("design") when Design is clicked from chat mode', () => {
    const onChange = vi.fn();
    render(<SessionModePicker mode="chat" canDesign onChange={onChange} />);
    fireEvent.click(screen.getByTestId('session-mode-design'));
    expect(onChange).toHaveBeenCalledWith('design');
  });

  it('fires onChange("chat") when Chat is clicked from design mode', () => {
    const onChange = vi.fn();
    render(<SessionModePicker mode="design" canDesign onChange={onChange} />);
    fireEvent.click(screen.getByTestId('session-mode-chat'));
    expect(onChange).toHaveBeenCalledWith('chat');
  });

  it('does not fire onChange when clicking the already-active mode', () => {
    const onChange = vi.fn();
    render(<SessionModePicker mode="chat" canDesign onChange={onChange} />);
    fireEvent.click(screen.getByTestId('session-mode-chat'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables Design and does not fire onChange when canDesign is false', () => {
    const onChange = vi.fn();
    render(<SessionModePicker mode="chat" canDesign={false} onChange={onChange} />);
    const design = screen.getByTestId('session-mode-design');
    expect(design).toBeDisabled();
    fireEvent.click(design);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fire onChange while disabled (switch in flight)', () => {
    const onChange = vi.fn();
    render(<SessionModePicker mode="chat" canDesign disabled onChange={onChange} />);
    fireEvent.click(screen.getByTestId('session-mode-design'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

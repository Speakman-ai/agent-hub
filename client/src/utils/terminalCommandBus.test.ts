import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HELD_TERMINAL_COMMANDS,
  resetTerminalCommandBus,
  sendCommandToTerminal,
  subscribeToTerminalCommands,
} from './terminalCommandBus';

afterEach(() => resetTerminalCommandBus());

describe('terminalCommandBus', () => {
  it('delivers to a live subscriber for the same session only', () => {
    const listener = vi.fn();
    const other = vi.fn();
    subscribeToTerminalCommands('session-1', listener);
    subscribeToTerminalCommands('session-2', other);

    expect(sendCommandToTerminal('session-1', 'npm test')).toBe(true);

    expect(listener).toHaveBeenCalledWith('npm test');
    expect(other).not.toHaveBeenCalled();
  });

  it('holds commands sent before a pane subscribes and replays them on subscribe', () => {
    // The pane is lazily imported and only subscribes once its socket attaches,
    // so the first click almost always lands with nobody listening.
    expect(sendCommandToTerminal('session-1', 'git status')).toBe(false);
    expect(sendCommandToTerminal('session-1', 'git log')).toBe(false);

    const listener = vi.fn();
    subscribeToTerminalCommands('session-1', listener);

    expect(listener.mock.calls.map(([cmd]) => cmd)).toEqual(['git status', 'git log']);
  });

  it('replays the held backlog only once', () => {
    sendCommandToTerminal('session-1', 'ls');
    const first = vi.fn();
    const unsubscribe = subscribeToTerminalCommands('session-1', first);
    unsubscribe();

    const second = vi.fn();
    subscribeToTerminalCommands('session-1', second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps only the most recent held commands', () => {
    const commands = Array.from({ length: MAX_HELD_TERMINAL_COMMANDS + 2 }, (_, i) => `cmd-${i}`);
    for (const command of commands) sendCommandToTerminal('session-1', command);

    const listener = vi.fn();
    subscribeToTerminalCommands('session-1', listener);

    expect(listener.mock.calls.map(([cmd]) => cmd)).toEqual(commands.slice(2));
  });

  it('stops delivering after unsubscribe and holds again for the next subscriber', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToTerminalCommands('session-1', listener);
    unsubscribe();

    expect(sendCommandToTerminal('session-1', 'echo hi')).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    const next = vi.fn();
    subscribeToTerminalCommands('session-1', next);
    expect(next).toHaveBeenCalledWith('echo hi');
  });

  it('survives a listener unsubscribing while the send is fanning out', () => {
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    const first = vi.fn(() => unsubscribeSecond());
    subscribeToTerminalCommands('session-1', first);
    unsubscribeSecond = subscribeToTerminalCommands('session-1', second);

    expect(() => sendCommandToTerminal('session-1', 'pwd')).not.toThrow();
    expect(first).toHaveBeenCalledWith('pwd');
  });

  it('ignores empty commands and missing session ids', () => {
    const listener = vi.fn();
    subscribeToTerminalCommands('session-1', listener);

    expect(sendCommandToTerminal('session-1', '')).toBe(false);
    expect(sendCommandToTerminal('', 'ls')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

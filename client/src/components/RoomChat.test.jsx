import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RoomChat from './RoomChat.jsx';

/**
 * RoomChat — multi-line input behavior.
 *
 * The conference room composer must match the normal chat composer:
 *   - Enter sends the message
 *   - Shift+Enter inserts a newline (does NOT send)
 *
 * Regression test for the bug where the room's `<input>` could not
 * accept line breaks at all.
 */
describe('RoomChat multi-line input', () => {
  const baseRoom = {
    id: 'room-1',
    name: 'Test Room',
    agents: [{ id: 'a1', name: 'Alice', color: '#abc' }],
    max_turns: 10,
  };

  const baseProps = {
    room: baseRoom,
    agents: [{ id: 'a1', name: 'Alice', color: '#abc', active: true }],
    roomMessages: [],
    roomStreaming: null,
    roomThinking: null,
    roomProcessing: false,
    roomQueueLength: 0,
    onRoomUpdated: () => {},
  };

  it('renders a textarea (not a single-line input) so newlines can be typed', () => {
    render(<RoomChat {...baseProps} send={() => {}} />);
    const textbox = screen.getByPlaceholderText(/message the room/i);
    expect(textbox.tagName).toBe('TEXTAREA');
  });

  it('Enter without Shift sends the message', () => {
    const send = vi.fn();
    render(<RoomChat {...baseProps} send={send} />);

    const textbox = screen.getByPlaceholderText(/message the room/i);
    fireEvent.change(textbox, { target: { value: 'hello there' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'room_chat',
      roomId: 'room-1',
      content: 'hello there',
    });
  });

  it('Shift+Enter does NOT send (allows newline insertion)', () => {
    const send = vi.fn();
    render(<RoomChat {...baseProps} send={send} />);

    const textbox = screen.getByPlaceholderText(/message the room/i);
    fireEvent.change(textbox, { target: { value: 'line one' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });

    expect(send).not.toHaveBeenCalled();
  });

  it('sends a multi-line message verbatim when the user presses Enter', () => {
    const send = vi.fn();
    render(<RoomChat {...baseProps} send={send} />);

    const textbox = screen.getByPlaceholderText(/message the room/i);
    // Simulate the result of the user typing "line one", Shift+Enter, "line two"
    fireEvent.change(textbox, { target: { value: 'line one\nline two' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toBe('line one\nline two');
  });

  it('Enter with empty input does not send', () => {
    const send = vi.fn();
    render(<RoomChat {...baseProps} send={send} />);

    const textbox = screen.getByPlaceholderText(/message the room/i);
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });

    expect(send).not.toHaveBeenCalled();
  });

  it('Enter selects a mention when the autocomplete popup is open (does not send)', () => {
    const send = vi.fn();
    render(<RoomChat {...baseProps} send={send} />);

    const textbox = screen.getByPlaceholderText(/message the room/i);
    // Typing "@" with cursor right after should open the mention popup
    fireEvent.change(textbox, { target: { value: '@' } });
    // The change handler reads selectionStart from the event target; jsdom defaults to 0
    // so we explicitly drive the popup state by typing a query.
    fireEvent.change(textbox, { target: { value: '@A', selectionStart: 2 } });

    // Now the popup should be open with Alice visible. Enter should insert the mention, not send.
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });
    expect(send).not.toHaveBeenCalled();
  });
});

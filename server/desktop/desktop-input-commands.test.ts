import { describe, it, expect } from 'vitest';
import { DesktopInputError, buildDesktopInputCommand } from './desktop-input-commands.js';

const cmd = (event: unknown) => buildDesktopInputCommand(event as never).command;

describe('buildDesktopInputCommand', () => {
  it.each([
    [{ type: 'move', x: 0, y: 0 }, "xdotool 'mousemove' '0' '0'"],
    [{ type: 'click', x: 5, y: 6 }, "xdotool 'mousemove' '5' '6' 'click' '1'"],
    [
      { type: 'double_click', x: 5, y: 6, button: 'middle' },
      "xdotool 'mousemove' '5' '6' 'click' '--repeat' '2' '--delay' '100' '2'",
    ],
    [
      { type: 'key', combo: 'ctrl+shift+Tab' },
      "xdotool 'key' '--delay' '50' '--' 'ctrl+shift+Tab'",
    ],
    [
      { type: 'scroll', x: 100, y: 200, direction: 'down', amount: 4 },
      "xdotool 'mousemove' '100' '200' 'click' '--repeat' '4' '--delay' '30' '5'",
    ],
    [
      { type: 'drag', fromX: 1, fromY: 2, toX: 1279, toY: 799 },
      "xdotool 'mousemove' '1' '2' 'mousedown' '1' 'mousemove' '1279' '799' 'mouseup' '1'",
    ],
  ])('%j', (event, expected) => {
    expect(cmd(event)).toBe(`DISPLAY=:99 ${expected}`);
  });

  it('quotes typed text so the shell never interprets it', () => {
    expect(cmd({ type: 'type', text: "it's $(rm -rf ~)" })).toBe(
      `DISPLAY=:99 xdotool 'type' '--delay' '12' '--' 'it'\\''s $(rm -rf ~)'`,
    );
  });

  it('scales the deadline with typed length the same way the container daemon does', () => {
    const short = buildDesktopInputCommand({ type: 'type', text: 'a' }).timeoutMs;
    const long = buildDesktopInputCommand({ type: 'type', text: 'a'.repeat(1000) }).timeoutMs;
    expect(long - short).toBe(999 * 12 * 2);
  });

  it.each([
    { type: 'move', x: 1280, y: 0 },
    { type: 'click', x: -1, y: 0 },
    { type: 'click', x: 0, y: 800 },
    { type: 'click', x: 1.5, y: 0 },
    { type: 'key', combo: 'ctrl+l; reboot' },
    { type: 'key', combo: '' },
    { type: 'type', text: '' },
    { type: 'scroll', x: 0, y: 0, direction: 'down', amount: 0 },
    { type: 'scroll', x: 0, y: 0, direction: 'sideways' },
    { type: 'click', x: 0, y: 0, button: 'fourth' },
  ])('rejects %j', (event) => {
    expect(() => cmd(event)).toThrow(DesktopInputError);
  });
});

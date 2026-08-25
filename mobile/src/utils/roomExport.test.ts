// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { formatRoomExport, queueIndicatorText } from './roomExport';
describe('formatRoomExport', () => {
  const fixedNow = new Date('2026-04-18T01:23:45Z');
  it('uses the room name in the header', () => {
    const text = formatRoomExport({
      room: { name: 'Standup', agents: [] },
      messages: [],
      now: fixedNow,
    });
    expect(text.split('\n')[0]).toBe('# Standup — Room Export');
  });
  it('falls back to a generic title when room is missing', () => {
    const text = formatRoomExport({ messages: [], now: fixedNow });
    expect(text.split('\n')[0]).toBe('# Conference Room — Room Export');
  });
  it('lists agents in the header when the room has any', () => {
    const text = formatRoomExport({
      room: {
        name: 'Standup',
        agents: [{ name: 'Alice' }, { name: 'Bob' }],
      },
      messages: [],
      now: fixedNow,
    });
    expect(text).toContain('Agents: Alice, Bob');
  });
  it('omits the agent line when no agents are present', () => {
    const text = formatRoomExport({
      room: { name: 'Empty', agents: [] },
      messages: [],
      now: fixedNow,
    });
    expect(text).not.toContain('Agents:');
  });
  it('formats user messages with the User label and agent messages with agent_name', () => {
    const text = formatRoomExport({
      room: { name: 'Room' },
      messages: [
        { role: 'user', content: 'Hi all' },
        { role: 'assistant', agent_name: 'Alice', content: 'Hello' },
        { role: 'assistant', content: 'anon' }, // missing agent_name → 'Agent'
      ],
      now: fixedNow,
    });
    expect(text).toContain('**User:**\nHi all');
    expect(text).toContain('**Alice:**\nHello');
    expect(text).toContain('**Agent:**\nanon');
  });
  it('handles missing messages array defensively', () => {
    const text = formatRoomExport({ room: { name: 'X' }, now: fixedNow });
    expect(typeof text).toBe('string');
    expect(text).toContain('# X — Room Export');
  });
  it('handles undefined content without throwing', () => {
    const text = formatRoomExport({
      room: { name: 'X' },
      messages: [{ role: 'user' }],
      now: fixedNow,
    });
    expect(text).toContain('**User:**');
  });
});
describe('queueIndicatorText', () => {
  it('returns null when the room is not processing', () => {
    expect(queueIndicatorText({ roomProcessing: false, roomQueueLength: 3 })).toBeNull();
  });
  it('returns null when the queue is empty', () => {
    expect(queueIndicatorText({ roomProcessing: true, roomQueueLength: 0 })).toBeNull();
    expect(queueIndicatorText({ roomProcessing: true })).toBeNull();
  });
  it('uses singular "message" for queue length 1', () => {
    expect(queueIndicatorText({ roomProcessing: true, roomQueueLength: 1 })).toBe(
      '1 message queued — will be sent after agents finish',
    );
  });
  it('uses plural "messages" for queue length > 1', () => {
    expect(queueIndicatorText({ roomProcessing: true, roomQueueLength: 4 })).toBe(
      '4 messages queued — will be sent after agents finish',
    );
  });
  it('coerces non-number queue lengths safely', () => {
    expect(queueIndicatorText({ roomProcessing: true, roomQueueLength: '2' })).toContain(
      '2 messages',
    );
    expect(queueIndicatorText({ roomProcessing: true, roomQueueLength: null })).toBeNull();
  });
});

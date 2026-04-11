import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatSessionExport, formatRoomExport } from './export.js';

describe('formatSessionExport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats a basic session with agent and messages', () => {
    const result = formatSessionExport({
      agent: { name: 'TestBot', engine: 'claude-code' },
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    });

    expect(result).toContain('# TestBot — Session Export');
    expect(result).toContain('Engine: claude-code');
    expect(result).toContain('**User:**');
    expect(result).toContain('Hello');
    expect(result).toContain('**TestBot:**');
    expect(result).toContain('Hi there!');
  });

  it('uses "Chat" when agent name is missing', () => {
    const result = formatSessionExport({
      agent: null,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result).toContain('# Chat — Session Export');
    expect(result).toContain('**User:**');
  });

  it('uses "Assistant" for assistant messages when no agent name', () => {
    const result = formatSessionExport({
      agent: null,
      messages: [{ role: 'assistant', content: 'Hi' }],
    });

    expect(result).toContain('**Assistant:**');
  });

  it('prefers sessionEngine over agent.engine', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot', engine: 'claude-code' },
      sessionEngine: 'cursor-agent',
      messages: [],
    });

    expect(result).toContain('Engine: cursor-agent');
  });

  it('omits engine line when neither is set', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot' },
      messages: [],
    });

    expect(result).not.toContain('Engine:');
  });

  it('includes exported timestamp', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot' },
      messages: [],
    });

    expect(result).toContain('Exported:');
  });
});

describe('formatRoomExport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats room with agents and messages', () => {
    const result = formatRoomExport({
      room: {
        name: 'Design Review',
        agents: [{ name: 'Alice' }, { name: 'Bob' }],
      },
      messages: [
        { role: 'user', content: 'Start review' },
        { role: 'assistant', agent_name: 'Alice', content: 'On it' },
        { role: 'assistant', agent_name: 'Bob', content: 'Agreed' },
      ],
    });

    expect(result).toContain('# Design Review — Room Export');
    expect(result).toContain('Agents: Alice, Bob');
    expect(result).toContain('**User:**');
    expect(result).toContain('**Alice:**');
    expect(result).toContain('**Bob:**');
  });

  it('uses "Conference Room" when room name is missing', () => {
    const result = formatRoomExport({
      room: null,
      messages: [],
    });

    expect(result).toContain('# Conference Room — Room Export');
  });

  it('uses "Agent" when agent_name is missing on assistant message', () => {
    const result = formatRoomExport({
      room: { name: 'Room' },
      messages: [{ role: 'assistant', content: 'Hello' }],
    });

    expect(result).toContain('**Agent:**');
  });

  it('omits agents line when room has no agents', () => {
    const result = formatRoomExport({
      room: { name: 'Empty Room', agents: [] },
      messages: [],
    });

    expect(result).not.toContain('Agents:');
  });
});

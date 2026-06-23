import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatSessionExport,
  formatRoomExport,
  buildNoteTitle,
  saveConversationAsNote,
} from './export';

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

    expect(result!).toContain('# TestBot — Session Export');
    expect(result!).toContain('Engine: claude-code');
    expect(result!).toContain('**User:**');
    expect(result!).toContain('Hello');
    expect(result!).toContain('**TestBot:**');
    expect(result!).toContain('Hi there!');
  });

  it('uses "Chat" when agent name is missing', () => {
    const result = formatSessionExport({
      agent: null,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result!).toContain('# Chat — Session Export');
    expect(result!).toContain('**User:**');
  });

  it('uses "Assistant" for assistant messages when no agent name', () => {
    const result = formatSessionExport({
      agent: null,
      messages: [{ role: 'assistant', content: 'Hi' }],
    });

    expect(result!).toContain('**Assistant:**');
  });

  it('prefers sessionEngine over agent.engine', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot', engine: 'claude-code' },
      sessionEngine: 'cursor-agent',
      messages: [],
    });

    expect(result!).toContain('Engine: cursor-agent');
  });

  it('omits engine line when neither is set', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot' },
      messages: [],
    });

    expect(result!).not.toContain('Engine:');
  });

  it('includes exported timestamp', () => {
    const result = formatSessionExport({
      agent: { name: 'Bot' },
      messages: [],
    });

    expect(result!).toContain('Exported:');
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

    expect(result!).toContain('# Design Review — Room Export');
    expect(result!).toContain('Agents: Alice, Bob');
    expect(result!).toContain('**User:**');
    expect(result!).toContain('**Alice:**');
    expect(result!).toContain('**Bob:**');
  });

  it('uses "Conference Room" when room name is missing', () => {
    const result = formatRoomExport({
      room: null,
      messages: [],
    });

    expect(result!).toContain('# Conference Room — Room Export');
  });

  it('uses "Agent" when agent_name is missing on assistant message', () => {
    const result = formatRoomExport({
      room: { name: 'Room' },
      messages: [{ role: 'assistant', content: 'Hello' }],
    });

    expect(result!).toContain('**Agent:**');
  });

  it('omits agents line when room has no agents', () => {
    const result = formatRoomExport({
      room: { name: 'Empty Room', agents: [] },
      messages: [],
    });

    expect(result!).not.toContain('Agents:');
  });
});

describe('buildNoteTitle', () => {
  const now = new Date('2026-04-18T10:00:00Z');

  it('uses agent name and date for a raw session save', () => {
    const title = buildNoteTitle({ kind: 'raw', agent: { name: 'TestBot' }, now });
    expect(title!).toBe('TestBot — raw — 2026-04-18');
  });

  it('uses agent name and date for a summary session save', () => {
    const title = buildNoteTitle({ kind: 'summary', agent: { name: 'TestBot' }, now });
    expect(title!).toBe('TestBot — summary — 2026-04-18');
  });

  it('falls back to "Chat" when no agent', () => {
    const title = buildNoteTitle({ kind: 'raw', now });
    expect(title!).toBe('Chat — raw — 2026-04-18');
  });

  it('uses quoted room name when saving a room conversation', () => {
    const title = buildNoteTitle({ kind: 'summary', room: { name: 'Design Review' }, now });
    expect(title!).toBe('Room "Design Review" — summary — 2026-04-18');
  });

  it('prefers room over agent when both provided', () => {
    const title = buildNoteTitle({
      kind: 'raw',
      agent: { name: 'Alice' },
      room: { name: 'Standup' },
      now,
    });
    expect(title!).toBe('Room "Standup" — raw — 2026-04-18');
  });

  it('falls back to "Conference Room" when room name is missing', () => {
    const title = buildNoteTitle({ kind: 'raw', room: {}, now });
    expect(title!).toBe('Room "Conference Room" — raw — 2026-04-18');
  });

  it('treats non-summary kinds as raw label', () => {
    const title = buildNoteTitle({ kind: 'anything-else', agent: { name: 'Bot' }, now });
    expect(title!).toBe('Bot — raw — 2026-04-18');
  });

  it('zero-pads single-digit months and days', () => {
    const title = buildNoteTitle({
      kind: 'raw',
      agent: { name: 'Bot' },
      now: new Date('2026-01-05T10:00:00Z'),
    });
    expect(title!).toContain('2026-01-05');
  });
});

describe('saveConversationAsNote', () => {
  it('returns ok + the created note on success', async () => {
    const note = { id: 'n1', title: 'T', content: 'C' };
    const api = { createNote: vi.fn().mockResolvedValue(note) };
    const result = await saveConversationAsNote({
      api,
      projectId: 'proj-a',
      title: 'T',
      content: 'C',
    });
    expect(result!).toEqual({ ok: true, note });
    expect(api.createNote).toHaveBeenCalledWith('proj-a', { title: 'T', content: 'C' });
  });

  it('defaults content to empty string when omitted', async () => {
    const api = { createNote: vi.fn().mockResolvedValue({ id: 'n' }) };
    await saveConversationAsNote({ api, projectId: 'p', title: 'hi' });
    expect(api.createNote).toHaveBeenCalledWith('p', { title: 'hi', content: '' });
  });

  it('returns { ok: false, error } when the API rejects', async () => {
    const api = { createNote: vi.fn().mockRejectedValue(new Error('409 duplicate')) };
    const result = await saveConversationAsNote({
      api,
      projectId: 'p',
      title: 't',
      content: 'c',
    });
    expect(result!.ok).toBe(false);
    expect(result!.error).toBeInstanceOf(Error);
    expect((result!.error as Error).message).toBe('409 duplicate');
  });

  it('returns error without calling API when projectId missing', async () => {
    const api = { createNote: vi.fn() };
    const result = await saveConversationAsNote({ api, projectId: '', title: 't' });
    expect(result!.ok).toBe(false);
    expect((result!.error as Error).message).toBe('Missing projectId');
    expect(api.createNote).not.toHaveBeenCalled();
  });

  it('returns error without calling API when title missing', async () => {
    const api = { createNote: vi.fn() };
    const result = await saveConversationAsNote({ api, projectId: 'p', title: '' });
    expect(result!.ok).toBe(false);
    expect((result!.error as Error).message).toBe('Missing title');
    expect(api.createNote).not.toHaveBeenCalled();
  });

  it('coerces non-Error rejections into Error instances', async () => {
    const api = { createNote: vi.fn().mockRejectedValue('plain string') };
    const result = await saveConversationAsNote({
      api,
      projectId: 'p',
      title: 't',
      content: 'c',
    });
    expect(result!.error).toBeInstanceOf(Error);
    expect((result!.error as Error).message).toBe('plain string');
  });
});

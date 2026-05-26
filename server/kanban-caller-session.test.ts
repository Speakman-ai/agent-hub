import { describe, it, expect, vi } from 'vitest';
import {
  AGENT_HUB_SESSION_ID_HEADER,
  maybeRenameSessionForLinkedCard,
  resolveCardSessionId,
} from './kanban-caller-session.js';
import type { Stmts } from './types.js';

describe('resolveCardSessionId', () => {
  const headerReq = {
    get: (name: string) =>
      name.toLowerCase() === AGENT_HUB_SESSION_ID_HEADER ? 'header-session' : undefined,
  } as unknown as import('express').Request;

  it('prefers explicit body over header', () => {
    expect(resolveCardSessionId(headerReq, 'body-session')).toBe('body-session');
  });

  it('uses header when body key is omitted (undefined)', () => {
    expect(resolveCardSessionId(headerReq, undefined)).toBe('header-session');
  });

  it('honors explicit null in body — header does not override', () => {
    expect(resolveCardSessionId(headerReq, null)).toBeNull();
  });

  it('does not fall back to header when body sends empty string', () => {
    expect(resolveCardSessionId(headerReq, '')).toBeNull();
    expect(resolveCardSessionId(headerReq, '   ')).toBeNull();
  });

  it('treats empty header as absent', () => {
    const req = {
      get: () => '',
      authSpawnSessionId: 'spawn-session',
    } as unknown as import('express').Request;
    expect(resolveCardSessionId(req, undefined)).toBe('spawn-session');
  });

  it('uses authSpawnSessionId when body and header omit', () => {
    const req = {
      get: () => undefined,
      authSpawnSessionId: 'spawn-session',
    } as unknown as import('express').Request;
    expect(resolveCardSessionId(req, undefined)).toBe('spawn-session');
  });
});

describe('maybeRenameSessionForLinkedCard', () => {
  it('no-ops when session name is already customized', () => {
    const updateSessionName = vi.fn();
    const stmts = {
      getSession: {
        get: () => ({ id: 'sess-1', name: 'Already Custom', agent_id: 'agent-1' }),
      },
      updateSessionName: { run: updateSessionName },
    } as unknown as Stmts;

    const broadcast = vi.fn();
    maybeRenameSessionForLinkedCard(stmts, broadcast, 'sess-1', 'New Card Title');

    expect(updateSessionName).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('renames placeholder Session titles and broadcasts session-updated', () => {
    const updateSessionName = vi.fn();
    const updatedRow = { id: 'sess-2', name: 'Card Title', agent_id: 'agent-1' };
    const stmts = {
      getSession: {
        get: (id: string) =>
          id === 'sess-2'
            ? { id: 'sess-2', name: 'Session 5/26/2026, 7:00 PM', agent_id: 'agent-1' }
            : updatedRow,
      },
      updateSessionName: { run: updateSessionName },
    } as unknown as Stmts;

    const broadcast = vi.fn();
    maybeRenameSessionForLinkedCard(stmts, broadcast, 'sess-2', 'Card Title');

    expect(updateSessionName).toHaveBeenCalledWith('Card Title', 'sess-2');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-updated' }));
  });
});

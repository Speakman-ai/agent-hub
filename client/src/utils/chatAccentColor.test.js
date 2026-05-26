import { describe, it, expect } from 'vitest';
import { indexSessionsById, resolveChatAccentColor } from './chatAccentColor.js';

describe('resolveChatAccentColor', () => {
  const agents = [
    { id: 'a-hub', projectId: 'p-hub', color: '#111111' },
    { id: 'a-st', projectId: 'p-st', color: '#222222' },
  ];
  const projects = [
    { id: 'p-hub', color: '#8B5CF6' },
    { id: 'p-st', color: '#10B981' },
  ];

  it('prefers project color over agent color for the session owner', () => {
    expect(
      resolveChatAccentColor({
        sessionRow: { agent_id: 'a-st' },
        agents,
        projects,
      }),
    ).toBe('#10B981');
  });

  it('resolves owner via sessionsById when switching cross-project sessions', () => {
    const sessionsById = indexSessionsById(new Map(), [{ id: 'sess-st', agent_id: 'a-st' }]);
    expect(
      resolveChatAccentColor({
        sessionId: 'sess-st',
        sessionsById,
        agents,
        projects,
        fallbackAgentId: 'a-hub',
      }),
    ).toBe('#10B981');
  });

  it('falls back to fallbackAgentId when session is unknown', () => {
    expect(
      resolveChatAccentColor({
        sessionId: 'missing',
        agents,
        projects,
        fallbackAgentId: 'a-hub',
      }),
    ).toBe('#8B5CF6');
  });
});

describe('indexSessionsById', () => {
  it('indexes rows by id', () => {
    const map = indexSessionsById(new Map(), [
      { id: 's1', agent_id: 'a1' },
      { id: 's2', agent_id: 'a2' },
    ]);
    expect(map.get('s2')?.agent_id).toBe('a2');
  });
});

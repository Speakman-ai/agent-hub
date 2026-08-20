import { describe, it, expect } from 'vitest';
import {
  dailySummaryCardHref,
  dailySummaryProjectHref,
  dailySummarySessionHref,
  dailySummaryTodoHref,
  dispatchDailySummaryHref,
  linkifyDailySummaryMarkdown,
  parseDailySummaryHref,
} from './dailySummaryLinks';

describe('daily summary hrefs', () => {
  it('round-trips card, session, todo, and project paths', () => {
    const card = dailySummaryCardHref('agent-hub', 'card-1');
    expect(card).toBe('/projects/agent-hub/board?card=card-1');
    expect(parseDailySummaryHref(card)).toEqual({
      type: 'card',
      projectId: 'agent-hub',
      cardId: 'card-1',
    });
    expect(
      parseDailySummaryHref('https://hub.example.com/projects/agent-hub/board?card=card-1'),
    ).toEqual({
      type: 'card',
      projectId: 'agent-hub',
      cardId: 'card-1',
    });

    const session = dailySummarySessionHref('sess-9', '__hub_assistant__');
    expect(parseDailySummaryHref(session)).toEqual({
      type: 'session',
      sessionId: 'sess-9',
      agentId: '__hub_assistant__',
    });
    expect(parseDailySummaryHref(dailySummaryTodoHref())).toEqual({ type: 'todo' });
    expect(parseDailySummaryHref(dailySummaryProjectHref('agent-hub'))).toEqual({
      type: 'project',
      projectId: 'agent-hub',
    });
    expect(parseDailySummaryHref('https://example.com/other')).toBeNull();
  });

  it('dispatches to the matching handler', () => {
    const seen: string[] = [];
    expect(
      dispatchDailySummaryHref(dailySummaryCardHref('p', 'c'), {
        onCard: (projectId, cardId) => seen.push(`card:${projectId}:${cardId}`),
      }),
    ).toBe(true);
    expect(
      dispatchDailySummaryHref(dailySummarySessionHref('s', 'a'), {
        onSession: (sessionId, agentId) => seen.push(`session:${sessionId}:${agentId}`),
      }),
    ).toBe(true);
    expect(dispatchDailySummaryHref('/nope', { onTodo: () => seen.push('todo') })).toBe(false);
    expect(seen).toEqual(['card:p:c', 'session:s:a']);
  });
});

describe('linkifyDailySummaryMarkdown', () => {
  const refs = [
    { label: 'Ship summary', href: dailySummarySessionHref('sess-1', 'dev') },
    { label: 'Today card', href: dailySummaryCardHref('agent-hub', 'card-1') },
    { label: 'Agent Hub', href: dailySummaryProjectHref('agent-hub') },
  ];

  it('wraps leftover titles and ids without rewriting existing links or code', () => {
    const md = [
      '## Today',
      '- finished [Today card](/projects/agent-hub/board?card=card-1)',
      '- also Ship summary in Agent Hub',
      '- raw id sess-skip and `Today card`',
      '```',
      'Today card',
      '```',
    ].join('\n');
    const out = linkifyDailySummaryMarkdown(md, refs);
    expect(out).toContain('[Today card](/projects/agent-hub/board?card=card-1)');
    expect(out).toContain('[Ship summary](/sessions/sess-1?agent=dev)');
    expect(out).toContain('[Agent Hub](/projects/agent-hub/board)');
    expect(out).toContain('`Today card`');
    expect(out).toContain('```\nToday card\n```');
    expect(out.match(/\[Today card]/g)?.length).toBe(1);
  });

  it('turns a bare UUID into the titled link', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const href = dailySummaryCardHref('p', id);
    const out = linkifyDailySummaryMarkdown(`see ${id}`, [{ label: 'Fix login', href }]);
    expect(out).toBe(`see [Fix login](${href})`);
  });
});

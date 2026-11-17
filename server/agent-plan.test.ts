import { describe, it, expect, vi } from 'vitest';
import { createAgentPlanEmitter } from './agent-plan.js';

function makeDeps() {
  const rows = new Map<string, Record<string, unknown>>();
  const addMessage = {
    run: vi.fn(
      (id: string, sessionId: string, role: string, content: string, ...rest: unknown[]) => {
        rows.set(id, { id, session_id: sessionId, role, content, metadata: rest[3] });
      },
    ),
  };
  const stmts = {
    addMessage,
    touchSession: { run: vi.fn() },
    getMessageById: { get: vi.fn((id: string) => rows.get(id)) },
  } as any;
  const broadcast = vi.fn();
  let n = 0;
  return { stmts, broadcast, newId: () => `plan-${++n}`, addMessage };
}

describe('createAgentPlanEmitter', () => {
  it('writes each completed plan once as it streams in, then broadcasts it', () => {
    const deps = makeDeps();
    const emit = createAgentPlanEmitter({ sessionId: 's1', ...deps });

    expect(emit('Reading code. <agenthub:plan>- edit a')).toEqual([]);
    const text = 'Reading code. <agenthub:plan>- edit a.ts</agenthub:plan>';
    expect(emit(text)).toEqual(['plan-1']);
    // Later chunks re-scan the whole buffer; the same plan must not repeat.
    expect(emit(`${text} now editing`)).toEqual([]);

    expect(deps.addMessage.run).toHaveBeenCalledTimes(1);
    const args = deps.addMessage.run.mock.calls[0];
    expect(args.slice(0, 4)).toEqual(['plan-1', 's1', 'system', '**Plan**\n\n- edit a.ts']);
    expect(JSON.parse(args[7] as string)).toEqual({ kind: 'agent_plan', plan: '- edit a.ts' });
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', sessionId: 's1' }),
    );
  });

  it('writes a revised plan later in the same turn', () => {
    const deps = makeDeps();
    const emit = createAgentPlanEmitter({ sessionId: 's1', ...deps });
    emit('<agenthub:plan>first</agenthub:plan>');
    expect(
      emit('<agenthub:plan>first</agenthub:plan> x <agenthub:plan>second</agenthub:plan>'),
    ).toEqual(['plan-2']);
  });

  it('retries a plan whose insert failed on the next chunk, without duplicating', () => {
    const deps = makeDeps();
    deps.addMessage.run.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const log = vi.fn();
    const emit = createAgentPlanEmitter({ sessionId: 's1', ...deps, log });
    expect(emit('<agenthub:plan>p</agenthub:plan>')).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db locked'));
    expect(deps.broadcast).not.toHaveBeenCalled();

    expect(emit('<agenthub:plan>p</agenthub:plan> more')).toEqual(['plan-2']);
    expect(emit('<agenthub:plan>p</agenthub:plan> more still')).toEqual([]);
    expect(deps.addMessage.run).toHaveBeenCalledTimes(2);
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });
});

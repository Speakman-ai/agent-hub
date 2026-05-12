/**
 * Unit tests for the multi-process preview graph validator + topo
 * sort. Exercises the acceptance criteria called out in the multi-
 * process preview card:
 *
 *   - process name shape enforced (kebab-case, leading lowercase letter)
 *   - duplicate names rejected
 *   - dependsOn references must resolve to existing process names
 *   - self-dependency rejected
 *   - cycles rejected with a recoverable error path
 *   - topological order grouped into waves (A → B → C unblocks B then C)
 *   - bounded to MAX_PROCESSES
 *
 * No IO, no DB — the graph helper is intentionally pure so a config
 * save can reject a busted `processes[]` block before the runtime ever
 * spawns anything.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_PROCESSES,
  formatGraphError,
  pickDefaultProcess,
  validateProcessGraph,
} from './preview-process-graph.js';
import type { PreviewProcess } from '../types.js';

function p(
  name: string,
  dependsOn: string[] = [],
  extra: Partial<PreviewProcess> = {},
): PreviewProcess {
  return { name, startScript: `echo ${name}`, dependsOn, ...extra };
}

describe('validateProcessGraph — happy paths', () => {
  it('accepts a single-process graph and returns one wave', () => {
    const res = validateProcessGraph([p('app')]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.waves.map((w) => w.map((q) => q.name))).toEqual([['app']]);
  });

  it('orders A → B → C into three sequential waves', () => {
    const res = validateProcessGraph([p('c', ['b']), p('b', ['a']), p('a')]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.waves.map((w) => w.map((q) => q.name))).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups independent processes into a single wave (parallel boot)', () => {
    const res = validateProcessGraph([p('cache'), p('db'), p('queue')]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    // All three independent — should land in one wave, sorted by name.
    expect(res.waves).toHaveLength(1);
    expect(res.waves[0].map((q) => q.name)).toEqual(['cache', 'db', 'queue']);
  });

  it('models a diamond (a → b,c → d) as three waves', () => {
    const res = validateProcessGraph([p('a'), p('b', ['a']), p('c', ['a']), p('d', ['b', 'c'])]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.waves.map((w) => w.map((q) => q.name))).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('models the canonical backend → frontend graph', () => {
    const res = validateProcessGraph([p('backend'), p('frontend', ['backend'])]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.waves.map((w) => w.map((q) => q.name))).toEqual([['backend'], ['frontend']]);
  });
});

describe('validateProcessGraph — validation errors', () => {
  it('rejects an empty array', () => {
    const res = validateProcessGraph([]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('empty');
  });

  it('rejects too many processes', () => {
    const procs = Array.from({ length: MAX_PROCESSES + 1 }, (_, i) => p(`p${i}`));
    const res = validateProcessGraph(procs);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('too_many');
  });

  it.each([['UPPER'], ['1leading-digit'], ['-leading-dash'], ['has space'], [''], ['has.dot']])(
    'rejects invalid name %s',
    (badName) => {
      const res = validateProcessGraph([p(badName)]);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error.kind).toBe('invalid_name');
    },
  );

  it('accepts valid names that mix letters, digits, dashes, underscores', () => {
    const res = validateProcessGraph([p('a'), p('app-1'), p('worker_2'), p('z9')]);
    expect(res.ok).toBe(true);
  });

  it('rejects duplicate process names', () => {
    const res = validateProcessGraph([p('app'), p('app')]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('duplicate_name');
  });

  it('rejects a healthPath that does not start with /', () => {
    const res = validateProcessGraph([p('app', [], { healthPath: 'health' })]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('invalid_health_path');
  });

  it('rejects dependsOn referencing an unknown process', () => {
    const res = validateProcessGraph([p('app', ['ghost'])]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'unknown_dependency') throw new Error('wrong error');
    expect(res.error.missing).toBe('ghost');
  });

  it('rejects self-dependency', () => {
    const res = validateProcessGraph([p('app', ['app'])]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.kind).toBe('self_dependency');
  });

  it('rejects a two-node cycle a → b → a', () => {
    const res = validateProcessGraph([p('a', ['b']), p('b', ['a'])]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'cycle') throw new Error('wrong error');
    // Path must start and end at the same node.
    expect(res.error.path[0]).toBe(res.error.path[res.error.path.length - 1]);
  });

  it('rejects a three-node cycle a → b → c → a', () => {
    const res = validateProcessGraph([p('a', ['c']), p('b', ['a']), p('c', ['b'])]);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    if (res.error.kind !== 'cycle') throw new Error('wrong error');
    expect(res.error.path.length).toBeGreaterThanOrEqual(4);
  });
});

describe('formatGraphError', () => {
  it('formats each error kind into a single-line string', () => {
    expect(formatGraphError({ kind: 'empty' })).toMatch(/empty/);
    expect(formatGraphError({ kind: 'too_many', count: 7, max: 6 })).toMatch(/7.*6/);
    expect(formatGraphError({ kind: 'invalid_name', name: 'X' })).toMatch(/invalid/);
    expect(formatGraphError({ kind: 'duplicate_name', name: 'app' })).toMatch(/duplicate/);
    expect(formatGraphError({ kind: 'cycle', path: ['a', 'b', 'a'] })).toMatch(/a.*b.*a/);
  });
});

describe('pickDefaultProcess', () => {
  it('returns the last leaf in the final wave', () => {
    const res = validateProcessGraph([p('backend'), p('frontend', ['backend'])]);
    if (!res.ok) throw new Error('unreachable');
    const adj = new Map<string, string[]>([
      ['backend', ['frontend']],
      ['frontend', []],
    ]);
    expect(pickDefaultProcess(res.waves, adj).name).toBe('frontend');
  });

  it('falls back to the last process in the last wave when adj is omitted', () => {
    const res = validateProcessGraph([p('a'), p('b', ['a']), p('c', ['a'])]);
    if (!res.ok) throw new Error('unreachable');
    // last wave is [b, c] sorted alphabetically — picks 'c'
    expect(pickDefaultProcess(res.waves).name).toBe('c');
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  configureDbInstrumentation,
  recordStatementTiming,
  getDbInstrumentationSnapshot,
  resetDbInstrumentationStats,
  instrumentStatement,
  instrumentStmts,
  isDbInstrumentationEnabled,
  getDbSlowThresholdMs,
} from './db-instrumentation.js';

/** Minimal better-sqlite3-Statement-shaped fake with call counters. */
function makeFakeStmt() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    stmt: {
      source: 'SELECT 1',
      reader: true,
      run(...args: unknown[]) {
        calls.run++;
        return { changes: 1, args };
      },
      get(...args: unknown[]) {
        calls.get++;
        return { row: 1, args };
      },
      all(...args: unknown[]) {
        calls.all++;
        return [{ row: 1, args }];
      },
      pluck() {
        return this;
      },
    },
  };
}

/**
 * Fixture mirroring better-sqlite3's native `Statement`: `.source` / `.reader`
 * are prototype getters that unwrap `this`. Implemented via a private field, so
 * reading them with `this` set to a Proxy (rather than the real instance) throws
 * `TypeError` — the exact native-unwrap failure the receiver-forwarding fix
 * guards against.
 */
class NativeLikeStmt {
  #brand = true;
  calls = { run: 0, get: 0, all: 0 };
  get source(): string {
    return this.#brand ? 'SELECT 1' : '';
  }
  get reader(): boolean {
    return this.#brand;
  }
  run(...args: unknown[]) {
    this.calls.run++;
    return { changes: 1, args };
  }
  get(...args: unknown[]) {
    this.calls.get++;
    return { row: 1, args };
  }
  all(...args: unknown[]) {
    this.calls.all++;
    return [{ row: 1, args }];
  }
}

describe('db-instrumentation', () => {
  beforeEach(() => {
    resetDbInstrumentationStats();
    // Deterministic baseline: enabled, threshold 10ms, logging off (tests that
    // need logging opt in explicitly).
    configureDbInstrumentation({ enabled: true, slowThresholdMs: 10, logSlow: false });
  });

  afterEach(() => {
    resetDbInstrumentationStats();
    configureDbInstrumentation({ enabled: false, slowThresholdMs: 10, logSlow: true });
    vi.restoreAllMocks();
  });

  describe('configure', () => {
    it('applies enabled + threshold', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 25 });
      expect(isDbInstrumentationEnabled()).toBe(true);
      expect(getDbSlowThresholdMs()).toBe(25);
    });

    it('ignores invalid threshold values', () => {
      configureDbInstrumentation({ slowThresholdMs: 40 });
      configureDbInstrumentation({ slowThresholdMs: Number.NaN });
      expect(getDbSlowThresholdMs()).toBe(40);
      configureDbInstrumentation({ slowThresholdMs: -5 });
      expect(getDbSlowThresholdMs()).toBe(40);
    });

    // Regression: initDb passes config.dbInstrumentation, which is undefined
    // when a test mocks ./config.js with a partial config. This must not throw
    // (previously crashed DB init with "Cannot read properties of undefined").
    it('does not throw on undefined / null / non-object settings', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 22 });
      expect(() => configureDbInstrumentation(undefined)).not.toThrow();
      expect(() => configureDbInstrumentation(null)).not.toThrow();
      expect(() =>
        configureDbInstrumentation(42 as unknown as Record<string, never>),
      ).not.toThrow();
      // Prior valid settings are preserved (no-op on bad input).
      expect(isDbInstrumentationEnabled()).toBe(true);
      expect(getDbSlowThresholdMs()).toBe(22);
    });
  });

  describe('recordStatementTiming', () => {
    it('aggregates count, total, and max per tag', () => {
      recordStatementTiming('getFoo', 2);
      recordStatementTiming('getFoo', 8);
      recordStatementTiming('getBar', 1);
      const snap = getDbInstrumentationSnapshot();
      const foo = snap.statements.find((s) => s.tag === 'getFoo')!;
      expect(foo.count).toBe(2);
      expect(foo.totalMs).toBe(10);
      expect(foo.maxMs).toBe(8);
      expect(snap.totalCalls).toBe(3);
      expect(snap.totalStatements).toBe(2);
    });

    it('counts a call as slow only at or above the threshold', () => {
      configureDbInstrumentation({ slowThresholdMs: 10, logSlow: false });
      recordStatementTiming('q', 9.9); // below
      recordStatementTiming('q', 10); // at threshold → slow
      recordStatementTiming('q', 50); // above → slow
      const q = getDbInstrumentationSnapshot().statements.find((s) => s.tag === 'q')!;
      expect(q.count).toBe(3);
      expect(q.slowCount).toBe(2);
    });

    it('sorts snapshot by total wall time descending', () => {
      recordStatementTiming('slow', 100);
      recordStatementTiming('fast', 1);
      recordStatementTiming('mid', 20);
      const tags = getDbInstrumentationSnapshot().statements.map((s) => s.tag);
      expect(tags).toEqual(['slow', 'mid', 'fast']);
    });
  });

  describe('slow logging', () => {
    it('emits a tag + duration line without SQL or params when slow', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      configureDbInstrumentation({ slowThresholdMs: 5, logSlow: true });
      recordStatementTiming('getSecretRow', 42);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('getSecretRow');
      expect(msg).toContain('42');
      // The tag is the only identifier — no SQL text / bound params leak.
      expect(msg).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    });

    it('does not log below threshold', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      configureDbInstrumentation({ slowThresholdMs: 100, logSlow: true });
      recordStatementTiming('q', 5);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not log when logSlow is disabled even for slow calls', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      configureDbInstrumentation({ slowThresholdMs: 1, logSlow: false });
      recordStatementTiming('q', 999);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('instrumentStatement', () => {
    it('times run/get/all and records under the tag when enabled', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 0, logSlow: false });
      const { stmt, calls } = makeFakeStmt();
      const wrapped = instrumentStatement(stmt, 'myStmt');
      wrapped.run(1);
      wrapped.get(2);
      wrapped.all(3);
      // Underlying methods still invoked with the same args.
      expect(calls).toEqual({ run: 1, get: 1, all: 1 });
      const s = getDbInstrumentationSnapshot().statements.find((x) => x.tag === 'myStmt')!;
      expect(s.count).toBe(3);
    });

    it('returns the underlying method result unchanged', () => {
      const { stmt } = makeFakeStmt();
      const wrapped = instrumentStatement(stmt, 'r');
      expect(wrapped.run('x')).toEqual({ changes: 1, args: ['x'] });
      expect(wrapped.all('y')).toEqual([{ row: 1, args: ['y'] }]);
    });

    it('does NOT record timings when instrumentation is disabled', () => {
      configureDbInstrumentation({ enabled: false });
      const { stmt, calls } = makeFakeStmt();
      const wrapped = instrumentStatement(stmt, 'disabled');
      wrapped.run(1);
      wrapped.get(1);
      // The call still went through to the real statement.
      expect(calls.run).toBe(1);
      expect(calls.get).toBe(1);
      // But nothing was recorded.
      expect(
        getDbInstrumentationSnapshot().statements.find((s) => s.tag === 'disabled'),
      ).toBeUndefined();
    });

    it('passes through non-timed properties and methods', () => {
      const { stmt } = makeFakeStmt();
      const wrapped = instrumentStatement(stmt, 'pt');
      expect(wrapped.source).toBe('SELECT 1');
      expect(wrapped.reader).toBe(true);
      // pluck returns the underlying statement (chaining) without throwing.
      expect(typeof wrapped.pluck).toBe('function');
      expect(wrapped.pluck()).toBeDefined();
    });

    it('reads native-style prototype getters without throwing (this-unwrap safe)', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 0, logSlow: false });
      const stmt = new NativeLikeStmt();
      const wrapped = instrumentStatement(stmt, 'native');
      // Would throw TypeError if the Proxy forwarded itself as the getter
      // receiver (private-field read on a non-instance).
      expect(wrapped.source).toBe('SELECT 1');
      expect(wrapped.reader).toBe(true);
      // Timed methods still work and record under the tag.
      expect(wrapped.run()).toEqual({ changes: 1, args: [] });
      expect(getDbInstrumentationSnapshot().statements.find((s) => s.tag === 'native')!.count).toBe(
        1,
      );
    });
  });

  describe('instrumentStmts', () => {
    it('wraps every statement-shaped entry when enabled', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 0, logSlow: false });
      const a = makeFakeStmt();
      const b = makeFakeStmt();
      const map = { getA: a.stmt, getB: b.stmt, notAStmt: 42 };
      const wrapped = instrumentStmts(map);
      wrapped.getA.run();
      wrapped.getB.get();
      expect(wrapped.notAStmt).toBe(42);
      const snap = getDbInstrumentationSnapshot();
      expect(snap.statements.map((s) => s.tag).sort()).toEqual(['getA', 'getB']);
    });

    it('returns the map UNCHANGED (same reference) when disabled — zero overhead', () => {
      configureDbInstrumentation({ enabled: false });
      const a = makeFakeStmt();
      const map = { getA: a.stmt };
      const result = instrumentStmts(map);
      expect(result).toBe(map);
      expect(result.getA).toBe(a.stmt);
    });
  });

  describe('snapshot + reset', () => {
    it('reports enabled + threshold in the snapshot', () => {
      configureDbInstrumentation({ enabled: true, slowThresholdMs: 33 });
      const snap = getDbInstrumentationSnapshot();
      expect(snap.enabled).toBe(true);
      expect(snap.slowThresholdMs).toBe(33);
    });

    it('reset clears all aggregates', () => {
      recordStatementTiming('q', 5);
      expect(getDbInstrumentationSnapshot().totalCalls).toBe(1);
      resetDbInstrumentationStats();
      const snap = getDbInstrumentationSnapshot();
      expect(snap.totalCalls).toBe(0);
      expect(snap.statements).toHaveLength(0);
    });
  });
});

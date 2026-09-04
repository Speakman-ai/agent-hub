import { describe, it, expect } from 'vitest';
import {
  FAILOVER_EXHAUSTED_COOLDOWN_MS,
  parseExhaustedEngines,
  serializeExhaustedEngines,
  activeExhaustedEngines,
  recordExhaustedEngine,
  clearExhaustedEngine,
} from './session-failover-memory.js';

describe('session-failover-memory', () => {
  describe('parseExhaustedEngines', () => {
    it('parses a well-formed blob', () => {
      expect(parseExhaustedEngines('{"claude-code":100,"codex-cli":200}')).toEqual({
        'claude-code': 100,
        'codex-cli': 200,
      });
    });

    it('collapses null / empty / malformed input to {}', () => {
      for (const bad of [null, undefined, '', '   ', 'not json', '[1,2]', '42', '"x"']) {
        expect(parseExhaustedEngines(bad as string | null)).toEqual({});
      }
    });

    it('drops entries whose value is not a finite number', () => {
      expect(parseExhaustedEngines('{"a":1,"b":"x","c":null,"d":true,"e":1.5}')).toEqual({
        a: 1,
        e: 1.5,
      });
    });
  });

  describe('serializeExhaustedEngines', () => {
    it('returns null for an empty map so the column stays NULL', () => {
      expect(serializeExhaustedEngines({})).toBeNull();
    });

    it('round-trips a non-empty map', () => {
      const map = { 'claude-code': 5 };
      expect(parseExhaustedEngines(serializeExhaustedEngines(map))).toEqual(map);
    });
  });

  describe('activeExhaustedEngines', () => {
    it('returns only engines still within the cooldown window', () => {
      const now = 1_000_000;
      const map = {
        'claude-code': now - 1000, // fresh
        'codex-cli': now - (FAILOVER_EXHAUSTED_COOLDOWN_MS + 1), // expired
      };
      expect(activeExhaustedEngines(map, now).sort()).toEqual(['claude-code']);
    });

    it('honors an explicit cooldown override', () => {
      const now = 100;
      const map = { a: 50, b: 90 };
      expect(activeExhaustedEngines(map, now, 20).sort()).toEqual(['b']);
    });
  });

  describe('recordExhaustedEngine', () => {
    it('adds the engine at nowMs and does not mutate the input', () => {
      const map = { 'claude-code': 10 };
      const next = recordExhaustedEngine(map, 'codex-cli', 500);
      expect(next).toEqual({ 'claude-code': 10, 'codex-cli': 500 });
      expect(map).toEqual({ 'claude-code': 10 }); // unchanged
    });

    it('prunes entries past the cooldown while recording', () => {
      const now = 10_000_000;
      const map = {
        'claude-code': now - (FAILOVER_EXHAUSTED_COOLDOWN_MS + 1), // expired -> dropped
        'grok-cli': now - 1, // fresh -> kept
      };
      const next = recordExhaustedEngine(map, 'codex-cli', now);
      expect(Object.keys(next).sort()).toEqual(['codex-cli', 'grok-cli']);
    });

    it('refreshes the timestamp when the engine is already present', () => {
      const next = recordExhaustedEngine({ 'codex-cli': 1 }, 'codex-cli', 999);
      expect(next).toEqual({ 'codex-cli': 999 });
    });
  });

  describe('clearExhaustedEngine', () => {
    it('removes the engine and returns a new object', () => {
      const map = { 'claude-code': 1, 'codex-cli': 2 };
      const next = clearExhaustedEngine(map, 'codex-cli');
      expect(next).toEqual({ 'claude-code': 1 });
      expect(map).toEqual({ 'claude-code': 1, 'codex-cli': 2 }); // unchanged
    });

    it('returns the SAME reference when the engine is absent (no-op signal)', () => {
      const map = { 'claude-code': 1 };
      expect(clearExhaustedEngine(map, 'grok-cli')).toBe(map);
    });
  });
});

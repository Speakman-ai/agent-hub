import { describe, it, expect } from 'vitest';
import {
  PROVISIONING_PHASES,
  phasesForRequest,
  initialState,
  reduceEvent,
  classifyError,
  phaseTone,
  hasGithubFailure,
  LOG_BUFFER_MAX,
} from './provisioningStatus';

describe('provisioningStatus pure model', () => {
  describe('phasesForRequest', () => {
    it('returns the full phase list when GitHub and toolchain are on', () => {
      expect(phasesForRequest({ withGithub: true, withToolchain: true })).toEqual(
        PROVISIONING_PHASES,
      );
    });

    it('strips gh:true phases when GitHub integration is off', () => {
      const phases = phasesForRequest({ withGithub: false, withToolchain: true });
      expect(phases.some((p: any) => p.gh)).toBe(false);
      expect(phases.length).toBe(PROVISIONING_PHASES.filter((p: any) => !p.gh).length);
    });

    it('strips toolchain phases by default (blank / description-first scaffold)', () => {
      const phases = phasesForRequest({ withGithub: true });
      expect(phases.some((p: any) => p.toolchain)).toBe(false);
      expect(phases.map((p: any) => p.id)).not.toContain('wire-tests');
      expect(phases.map((p: any) => p.id)).not.toContain('wire-lint');
    });

    it('defaults withGithub to true and withToolchain to false', () => {
      expect(phasesForRequest()).toEqual(PROVISIONING_PHASES.filter((p: any) => !p.toolchain));
    });
  });

  describe('initialState', () => {
    it('marks every phase pending with null timestamps', () => {
      const s = initialState();
      expect(s.overall).toBe('idle');
      expect(s.repoUrl).toBeNull();
      expect(s.error).toBeNull();
      expect(s.logs).toEqual([]);
      for (const p of s.phases) {
        expect(p.status).toBe('pending');
        expect(p.startedAt).toBeNull();
        expect(p.finishedAt).toBeNull();
      }
    });
  });

  describe('reduceEvent — phase events', () => {
    it('transitions idle → running on first started phase', () => {
      const s = reduceEvent(initialState(), {
        type: 'phase',
        phase: 'validate',
        status: 'started',
        at: '2026-04-23T00:00:00Z',
      });
      expect(s.overall).toBe('running');
      expect(s.startedAt).toBe('2026-04-23T00:00:00Z');
      const p = s.phases.find((p: any) => p.id === 'validate');
      expect(p.status).toBe('started');
      expect(p.startedAt).toBe('2026-04-23T00:00:00Z');
      expect(p.finishedAt).toBeNull();
    });

    it('records finishedAt when a phase completes ok', () => {
      let s = initialState();
      s = reduceEvent(s, {
        type: 'phase',
        phase: 'validate',
        status: 'started',
        at: '2026-04-23T00:00:00Z',
      });
      s = reduceEvent(s, {
        type: 'phase',
        phase: 'validate',
        status: 'ok',
        at: '2026-04-23T00:00:05Z',
      });
      const p = s.phases.find((p: any) => p.id === 'validate');
      expect(p.status).toBe('ok');
      expect(p.finishedAt).toBe('2026-04-23T00:00:05Z');
    });

    it('ignores phase events for unknown phase ids (forward-compat)', () => {
      const s0 = initialState();
      const s1 = reduceEvent(s0, { type: 'phase', phase: 'future-phase', status: 'started' });
      expect(s1!).toBe(s0); // same reference → no-op
    });

    it('handles skipped status by setting finishedAt', () => {
      const s = reduceEvent(initialState(), {
        type: 'phase',
        phase: 'gh-create',
        status: 'skipped',
        at: '2026-04-23T01:00:00Z',
      });
      const p = s.phases.find((p: any) => p.id === 'gh-create');
      expect(p.status).toBe('skipped');
      expect(p.finishedAt).toBe('2026-04-23T01:00:00Z');
    });
  });

  describe('reduceEvent — log events', () => {
    it('appends log lines in order', () => {
      let s = initialState();
      s = reduceEvent(s, { type: 'log', line: 'first', at: '2026-04-23T00:00:00Z' });
      s = reduceEvent(s, { type: 'log', line: 'second', at: '2026-04-23T00:00:01Z' });
      expect(s.logs.map((l: any) => l.line)).toEqual(['first', 'second']);
    });

    it('drops empty lines', () => {
      const s = reduceEvent(initialState(), { type: 'log', line: '' });
      expect(s.logs).toEqual([]);
    });

    it('caps the log buffer at LOG_BUFFER_MAX', () => {
      let s = initialState();
      for (let i = 0; i < LOG_BUFFER_MAX + 25; i += 1) {
        s = reduceEvent(s, { type: 'log', line: `line ${i}` });
      }
      expect(s.logs).toHaveLength(LOG_BUFFER_MAX);
      // Oldest entries were dropped; newest preserved.
      expect(s.logs[s.logs.length - 1].line).toBe(`line ${LOG_BUFFER_MAX + 24}`);
    });
  });

  describe('reduceEvent — done events', () => {
    it('done with repoUrl only → overall: success', () => {
      const s = reduceEvent(initialState(), {
        type: 'done',
        repoUrl: 'https://github.com/acme/x',
      });
      expect(s.overall).toBe('success');
      expect(s.repoUrl).toBe('https://github.com/acme/x');
      expect(s.error).toBeNull();
    });

    it('done with error and partial:true → overall: partial', () => {
      const s = reduceEvent(initialState(), {
        type: 'done',
        partial: true,
        error: { code: 5, message: 'push failed' },
      });
      expect(s.overall).toBe('partial');
      expect(s.error).toEqual({ code: 5, message: 'push failed' });
    });

    it('done with error and no partial flag → overall: failed', () => {
      const s = reduceEvent(initialState(), {
        type: 'done',
        error: { code: 3, message: 'copy failed' },
      });
      expect(s.overall).toBe('failed');
      expect(s.error.code).toBe(3);
    });
  });

  describe('reduceEvent — malformed input', () => {
    it('no-ops on null / non-object', () => {
      const s0 = initialState();
      expect(reduceEvent(s0, null)).toBe(s0);
      expect(reduceEvent(s0, 'nope')).toBe(s0);
      expect(reduceEvent(s0, undefined)).toBe(s0);
    });

    it('no-ops on unknown event type', () => {
      const s0 = initialState();
      expect(reduceEvent(s0, { type: 'something-else' })).toBe(s0);
    });
  });

  describe('classifyError', () => {
    it('returns null when error is absent', () => {
      expect(classifyError(null)).toBeNull();
    });

    it('fills a hint matching the exit code', () => {
      const cls = classifyError({ code: 5, message: 'gh push failed' });
      expect(cls!.code).toBe(5);
      expect(cls!.hint).toMatch(/administration: write|owner/i);
    });

    it('maps a copy-template failure (code 3) to a permission-oriented hint', () => {
      const cls = classifyError({ code: 3, message: 'Failed to copy template' });
      expect(cls!.code).toBe(3);
      expect(cls!.hint).toMatch(/writable|ownership|UID/i);
      expect(cls!.hint).not.toMatch(/timed out|overloaded/i);
    });

    it('preserves server-provided hint over the default', () => {
      const cls = classifyError({
        code: 5,
        message: 'gh push failed',
        hint: 'use a fine-grained PAT',
      });
      expect(cls!.hint).toBe('use a fine-grained PAT');
    });

    it('handles unknown codes gracefully', () => {
      const cls = classifyError({ code: 999, message: 'weird' });
      expect(cls!.hint).toMatch(/unknown/i);
    });
  });

  describe('phaseTone', () => {
    it('maps status → tone per storyboard', () => {
      expect(phaseTone('ok')).toBe('green');
      expect(phaseTone('started')).toBe('amber');
      expect(phaseTone('failed')).toBe('red');
      expect(phaseTone('skipped')).toBe('grey');
      expect(phaseTone('pending')).toBe('grey');
      expect(phaseTone(undefined)).toBe('grey');
    });
  });

  describe('hasGithubFailure', () => {
    it('is true when a gh phase is failed', () => {
      let s = initialState();
      s = reduceEvent(s, { type: 'phase', phase: 'gh-push', status: 'failed' });
      expect(hasGithubFailure(s)).toBe(true);
    });

    it('is false when all gh phases are pending/ok/skipped', () => {
      let s = initialState();
      s = reduceEvent(s, { type: 'phase', phase: 'gh-create', status: 'ok' });
      expect(hasGithubFailure(s)).toBe(false);
    });
  });
});

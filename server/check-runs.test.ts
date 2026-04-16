import { describe, it, expect } from 'vitest';
import {
  CHECK_RUN_NAME,
  DEFAULT_REVIEWER_PHASES,
  MAX_ANNOTATIONS_PER_REQUEST,
  advancePhase,
  chunkAnnotations,
  finalizePhases,
  renderProgressSummary,
  resolveCheckRunAuth,
  reviewEventToConclusion,
  type CheckRunAnnotation,
  type CheckRunPhase,
} from './check-runs.js';
import type { AppConfig } from './types.js';

describe('check-runs — constants', () => {
  it('exposes the stable Check Run name', () => {
    // Changing this string renames the check in every open PR — treat as API.
    expect(CHECK_RUN_NAME).toBe('Agent Hub Reviewer');
  });

  it('enforces GitHub’s hard cap of 50 annotations per PATCH', () => {
    expect(MAX_ANNOTATIONS_PER_REQUEST).toBe(50);
  });

  it('ships a 4-step default reviewer phase list', () => {
    expect(DEFAULT_REVIEWER_PHASES.map((p) => p.key)).toEqual([
      'queue',
      'context',
      'analyze',
      'post',
    ]);
    expect(DEFAULT_REVIEWER_PHASES.every((p) => p.state === 'pending')).toBe(true);
  });
});

describe('reviewEventToConclusion', () => {
  it('maps APPROVE → success (green check)', () => {
    expect(reviewEventToConclusion('APPROVE')).toBe('success');
  });
  it('maps REQUEST_CHANGES → action_required (must-fix)', () => {
    expect(reviewEventToConclusion('REQUEST_CHANGES')).toBe('action_required');
  });
  it('maps COMMENT → neutral (non-blocking issues found)', () => {
    expect(reviewEventToConclusion('COMMENT')).toBe('neutral');
  });
});

describe('renderProgressSummary', () => {
  it('renders a checklist with markers for pending / in-progress / done', () => {
    const phases: CheckRunPhase[] = [
      { key: 'a', label: 'Context', state: 'done', elapsedMs: 1500 },
      { key: 'b', label: 'Analyze', state: 'in_progress' },
      { key: 'c', label: 'Post', state: 'pending' },
    ];
    const md = renderProgressSummary(phases, { headline: 'Reviewing PR #42' });
    expect(md).toContain('Reviewing PR #42');
    expect(md).toMatch(/✅ \*\*Context\*\*/);
    expect(md).toMatch(/🔄 \*\*Analyze\*\*/);
    expect(md).toMatch(/⏳ \*\*Post\*\*/);
  });

  it('formats elapsed ms as sub-second / seconds / minutes', () => {
    const make = (ms: number): CheckRunPhase[] => [
      { key: 'x', label: 'X', state: 'done', elapsedMs: ms },
    ];
    expect(renderProgressSummary(make(450))).toMatch(/450ms/);
    expect(renderProgressSummary(make(1500))).toMatch(/1\.5s/);
    expect(renderProgressSummary(make(75_000))).toMatch(/1m15s/);
  });

  it('renders an optional footer', () => {
    const md = renderProgressSummary([], { footer: '---\nNotes here' });
    expect(md).toContain('Notes here');
  });
});

describe('advancePhase', () => {
  it('marks the target phase in_progress and all prior phases done', () => {
    const phases = advancePhase(DEFAULT_REVIEWER_PHASES, 'analyze', 10_000, 0);
    const byKey = Object.fromEntries(phases.map((p) => [p.key, p]));
    expect(byKey.queue.state).toBe('done');
    expect(byKey.context.state).toBe('done');
    expect(byKey.analyze.state).toBe('in_progress');
    expect(byKey.post.state).toBe('pending');
  });

  it('fills elapsedMs on phases that transitioned to done', () => {
    const phases = advancePhase(DEFAULT_REVIEWER_PHASES, 'post', 10_000, 5_000);
    const done = phases.filter((p) => p.state === 'done');
    expect(done.length).toBe(3);
    expect(done.every((p) => typeof p.elapsedMs === 'number')).toBe(true);
  });

  it('does not mutate the input array', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_REVIEWER_PHASES));
    advancePhase(DEFAULT_REVIEWER_PHASES, 'context', 1_000, 0);
    expect(DEFAULT_REVIEWER_PHASES).toEqual(before);
  });
});

describe('finalizePhases', () => {
  it('marks every phase done with elapsed', () => {
    const final = finalizePhases(DEFAULT_REVIEWER_PHASES, 10_000, 0);
    expect(final.every((p) => p.state === 'done')).toBe(true);
    expect(final.every((p) => typeof p.elapsedMs === 'number')).toBe(true);
  });
});

describe('chunkAnnotations', () => {
  const mk = (n: number): CheckRunAnnotation[] =>
    Array.from({ length: n }, (_, i) => ({
      path: `f${i}.ts`,
      start_line: 1,
      end_line: 1,
      annotation_level: 'warning' as const,
      message: `m${i}`,
    }));

  it('returns [] for empty input', () => {
    expect(chunkAnnotations([])).toEqual([]);
  });

  it('packs ≤max per chunk', () => {
    const chunks = chunkAnnotations(mk(125), 50);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 25]);
  });

  it('defaults to GitHub’s 50-item cap', () => {
    const chunks = chunkAnnotations(mk(60));
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(50);
    expect(chunks[1].length).toBe(10);
  });
});

describe('resolveCheckRunAuth', () => {
  it('returns null when the GitHub App is not configured', () => {
    expect(resolveCheckRunAuth({} as AppConfig, 'some-org')).toBeNull();
  });

  it('returns null when App creds are present but owner has no installation', () => {
    const cfg = {
      githubApp: {
        appId: '1',
        privateKey: 'k',
        installations: [{ id: '99', account: 'other-org' }],
      },
    } as unknown as AppConfig;
    expect(resolveCheckRunAuth(cfg, 'unknown-org')).toBeNull();
  });

  it('returns { appId, privateKey, installationId } when owner matches', () => {
    const cfg = {
      githubApp: {
        appId: '42',
        privateKey: 'pk',
        installations: [{ id: '789', account: 'my-org' }],
      },
    } as unknown as AppConfig;
    const auth = resolveCheckRunAuth(cfg, 'my-org');
    expect(auth).toEqual({ appId: '42', privateKey: 'pk', installationId: '789' });
  });

  it('falls back to legacy installationId when installations[] lacks owner', () => {
    const cfg = {
      githubApp: {
        appId: '1',
        privateKey: 'pk',
        installationId: '555',
      },
    } as unknown as AppConfig;
    expect(resolveCheckRunAuth(cfg, 'whatever')).toEqual({
      appId: '1',
      privateKey: 'pk',
      installationId: '555',
    });
  });
});

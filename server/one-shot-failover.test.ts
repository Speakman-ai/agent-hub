/**
 * Background one-shot engine failover. The real CLI is never spawned — the
 * runner is injected (see server/test/setup.ts for the hard guard).
 */
import './test/setup.js';
import { describe, it, expect } from 'vitest';
import {
  runOneShotPromptWithFailover,
  formatFailoverSummary,
  type OneShotFailoverDeps,
} from './one-shot-failover.js';
import type { OneShotDetailed, RunOneShotOptions } from './one-shot-spawn.js';
import type { EngineAvailability, SupportedEngine } from './engine-availability.js';
import type { AppConfig } from './types.js';

const CFG = {
  engineDefaultModels: {
    'claude-code': 'claude-sonnet-4-5',
    'cursor-agent': 'auto',
    'codex-cli': 'gpt-5.4',
    'grok-cli': 'grok-4',
  },
  defaultModel: 'claude-sonnet-4-5',
  engineValidModels: {},
} as unknown as AppConfig;

function availability(
  ...available: SupportedEngine[]
): Record<SupportedEngine, EngineAvailability> {
  const engines: SupportedEngine[] = [
    'claude-code',
    'cursor-agent',
    'codex-cli',
    'gemini-cli',
    'grok-cli',
  ];
  const out = {} as Record<SupportedEngine, EngineAvailability>;
  for (const engine of engines) {
    out[engine] = available.includes(engine)
      ? { engine, available: true }
      : { engine, available: false, reason: 'no-credentials', detail: 'no creds' };
  }
  return out;
}

function detailed(over: Partial<OneShotDetailed> = {}): OneShotDetailed {
  return { stdout: '', stderr: '', code: 0, timedOut: false, ...over };
}

function makeDeps(
  runs: Array<(input: RunOneShotOptions) => OneShotDetailed | Promise<OneShotDetailed>>,
  available: SupportedEngine[],
): OneShotFailoverDeps & { calls: RunOneShotOptions[] } {
  const calls: RunOneShotOptions[] = [];
  let i = 0;
  return {
    calls,
    runOneShot: async (input) => {
      calls.push(input);
      const next = runs[Math.min(i, runs.length - 1)];
      i += 1;
      return next(input);
    },
    probeAvailability: async () => availability(...available),
  };
}

const BASE = {
  scope: 'heartbeat "Docs"',
  engine: 'claude-code' as SupportedEngine,
  model: 'claude-sonnet-4-5',
  userId: 'user-1',
  prompt: 'check in',
  cwd: '/tmp',
  timeoutMs: 60_000,
  buildEnv: (engine: SupportedEngine) => ({ ENGINE: engine }) as NodeJS.ProcessEnv,
};

describe('runOneShotPromptWithFailover', () => {
  it('returns the first engine result when the run succeeds', async () => {
    const deps = makeDeps([() => detailed({ stdout: 'all good', code: 0 })], ['codex-cli']);
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(out.engine).toBe('claude-code');
    expect(out.output).toBe('all good');
    expect(out.failovers).toEqual([]);
    expect(deps.calls).toHaveLength(1);
  });

  it('switches to the next engine in the chain when usage runs out mid-run', async () => {
    // This is the case pre-flight resolution cannot catch: Claude was
    // authenticated at spawn time and ran out of quota while running.
    const deps = makeDeps(
      [
        () => detailed({ stderr: 'Claude AI usage limit reached', code: 1 }),
        () => detailed({ stdout: 'done on codex', code: 0 }),
      ],
      ['codex-cli', 'cursor-agent', 'grok-cli'],
    );
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(out.engine).toBe('codex-cli');
    expect(out.model).toBe('gpt-5.4');
    expect(out.output).toBe('done on codex');
    expect(out.failovers).toHaveLength(1);
    expect(out.failovers[0]).toMatchObject({
      from: 'claude-code',
      to: 'codex-cli',
      trigger: 'usage-exhausted',
    });
  });

  it('rebuilds the spawn env for the engine that takes over', async () => {
    // The fallback CLI needs its own per-account credentials — reusing the
    // failed engine's env would spawn it logged out.
    const deps = makeDeps(
      [
        () => detailed({ stderr: 'usage limit reached', code: 1 }),
        () => detailed({ stdout: 'ok', code: 0 }),
      ],
      ['codex-cli'],
    );
    await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(deps.calls[0].env).toEqual({ ENGINE: 'claude-code' });
    expect(deps.calls[1].env).toEqual({ ENGINE: 'codex-cli' });
  });

  it('walks past a second exhausted engine without revisiting the first', async () => {
    const deps = makeDeps(
      [
        () => detailed({ stderr: 'usage limit reached', code: 1 }),
        () => detailed({ stderr: 'quota exceeded', code: 1 }),
        () => detailed({ stdout: 'grok saves the day', code: 0 }),
      ],
      ['codex-cli', 'grok-cli', 'claude-code'],
    );
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(deps.calls.map((c) => c.engine)).toEqual(['claude-code', 'codex-cli', 'grok-cli']);
    expect(out.engine).toBe('grok-cli');
    expect(out.failovers).toHaveLength(2);
  });

  it('fails over on a thrown spawn error too (auth rejection)', async () => {
    const deps = makeDeps(
      [
        () => {
          throw new Error('401 Unauthorized');
        },
        () => detailed({ stdout: 'ok', code: 0 }),
      ],
      ['codex-cli'],
    );
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(out.engine).toBe('codex-cli');
    expect(out.failovers[0].trigger).toBe('engine-auth');
  });

  it('fails over on a transient API error — background runs have no in-place retry', async () => {
    const deps = makeDeps(
      [
        () => detailed({ stderr: 'API Error: The socket connection was closed', code: 1 }),
        () => detailed({ stdout: 'ok', code: 0 }),
      ],
      ['codex-cli'],
    );
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(out.failovers[0].trigger).toBe('transient-exhausted');
  });

  it('does not burn a second engine on a failure another engine cannot fix', async () => {
    const deps = makeDeps(
      [() => detailed({ stderr: 'prompt is too long', code: 1 })],
      ['codex-cli', 'grok-cli'],
    );
    await expect(runOneShotPromptWithFailover(BASE, CFG, deps)).rejects.toThrow(
      /prompt is too long/,
    );
    expect(deps.calls).toHaveLength(1);
  });

  it('throws like the legacy non-detailed runner when nothing can take over', async () => {
    const deps = makeDeps([() => detailed({ stderr: 'usage limit reached', code: 1 })], []);
    await expect(runOneShotPromptWithFailover(BASE, CFG, deps)).rejects.toThrow(
      /usage limit reached/,
    );
  });

  it('resolves with the detailed result on failure when detailed:true (cron semantics)', async () => {
    const deps = makeDeps([() => detailed({ stderr: 'usage limit reached', code: 1 })], []);
    const out = await runOneShotPromptWithFailover({ ...BASE, detailed: true }, CFG, deps);
    expect(out.detailed.code).toBe(1);
    expect(out.output).toBe('usage limit reached');
    expect(out.failovers).toEqual([]);
  });

  it('treats a timeout as a switchable failure', async () => {
    const deps = makeDeps(
      [() => detailed({ code: null, timedOut: true }), () => detailed({ stdout: 'ok', code: 0 })],
      ['codex-cli'],
    );
    const out = await runOneShotPromptWithFailover(BASE, CFG, deps);
    expect(out.engine).toBe('codex-cli');
  });

  it('never selects the RAG-only gemini engine', async () => {
    const deps = makeDeps(
      [() => detailed({ stderr: 'usage limit reached', code: 1 })],
      ['gemini-cli'],
    );
    await expect(runOneShotPromptWithFailover(BASE, CFG, deps)).rejects.toThrow();
    expect(deps.calls.map((c) => c.engine)).toEqual(['claude-code']);
  });

  it('honours the codex-first chain for a codex-preferred run', async () => {
    const deps = makeDeps(
      [
        () => detailed({ stderr: 'usage limit reached', code: 1 }),
        () => detailed({ stdout: 'ok', code: 0 }),
      ],
      ['claude-code', 'grok-cli', 'cursor-agent'],
    );
    const out = await runOneShotPromptWithFailover(
      { ...BASE, engine: 'codex-cli', model: 'gpt-5.4' },
      CFG,
      deps,
    );
    expect(out.engine).toBe('claude-code');
  });
});

describe('formatFailoverSummary', () => {
  it('is empty when no switch happened', () => {
    expect(formatFailoverSummary([])).toBe('');
  });

  it('names each hop and the engine that finished the run', () => {
    const summary = formatFailoverSummary([
      {
        from: 'claude-code',
        fromModel: 'claude-sonnet-4-5',
        to: 'codex-cli',
        toModel: 'gpt-5.4',
        trigger: 'usage-exhausted',
        errorText: 'usage limit reached',
      },
    ]);
    expect(summary).toContain('claude-code → codex-cli');
    expect(summary).toContain('usage limit reached');
    expect(summary).toContain('gpt-5.4');
  });
});

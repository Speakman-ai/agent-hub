import './test/setup.js';
import { describe, it, expect } from 'vitest';
import {
  classifyEngineFailure,
  failoverChainFor,
  planEngineFailover,
  buildEngineFailoverNotice,
  buildNoFailoverEngineNotice,
  ENGINE_FAILOVER_CHAINS,
  FAILOVER_ELIGIBLE_ENGINES,
} from './engine-failover.js';
import { TRANSIENT_TURN_ERROR_MAX_RETRIES } from './turn-error.js';
import type { EngineAvailability, SupportedEngine } from './engine-availability.js';

function availability(
  overrides: Partial<Record<SupportedEngine, boolean>>,
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
    const available = overrides[engine] ?? false;
    out[engine] = available
      ? { engine, available: true }
      : { engine, available: false, reason: 'no-credentials', detail: 'no creds' };
  }
  return out;
}

describe('failover chains', () => {
  it('orders each engine chain as specified by the product decision', () => {
    expect(failoverChainFor('claude-code')).toEqual([
      'claude-code',
      'codex-cli',
      'grok-cli',
      'cursor-agent',
    ]);
    expect(failoverChainFor('codex-cli')).toEqual([
      'codex-cli',
      'claude-code',
      'grok-cli',
      'cursor-agent',
    ]);
    expect(failoverChainFor('grok-cli')).toEqual([
      'grok-cli',
      'claude-code',
      'codex-cli',
      'cursor-agent',
    ]);
    expect(failoverChainFor('cursor-agent')).toEqual([
      'cursor-agent',
      'claude-code',
      'codex-cli',
      'grok-cli',
    ]);
  });

  it('never offers the RAG-only gemini engine, even as the current engine', () => {
    for (const chain of Object.values(ENGINE_FAILOVER_CHAINS)) {
      expect(chain).not.toContain('gemini-cli');
    }
    expect(failoverChainFor('gemini-cli')).not.toContain('gemini-cli');
    expect(FAILOVER_ELIGIBLE_ENGINES).not.toContain('gemini-cli');
  });

  it('falls back to the claude-first chain for unknown or blank engines', () => {
    expect(failoverChainFor('not-an-engine')).toEqual(failoverChainFor('claude-code'));
    expect(failoverChainFor(null)).toEqual(failoverChainFor('claude-code'));
    expect(failoverChainFor('  ')).toEqual(failoverChainFor('claude-code'));
  });

  it('covers every selectable engine in every chain', () => {
    for (const engine of FAILOVER_ELIGIBLE_ENGINES) {
      const chain = failoverChainFor(engine);
      expect(chain[0]).toBe(engine);
      expect([...chain].sort()).toEqual([...FAILOVER_ELIGIBLE_ENGINES].sort());
    }
  });
});

describe('classifyEngineFailure', () => {
  it('classifies provider usage exhaustion', () => {
    const usage = [
      'Claude AI usage limit reached|1751500000',
      '5-hour limit reached — resets at 3pm',
      "You've reached your weekly limit for gpt-5-codex",
      'TerminalQuotaError: You have exhausted your daily quota on this model',
      'Quota exceeded for quota metric',
      'limit: 0',
      'Your credit balance is too low to access the API',
      'insufficient credits remaining',
      'Please upgrade to a paid plan to continue',
    ];
    for (const text of usage) {
      expect(classifyEngineFailure(text), text).toBe('usage-exhausted');
    }
  });

  it('classifies engine auth failures', () => {
    const auth = [
      'invalid x-api-key',
      'authentication_error: invalid bearer token',
      'HTTP 401 Unauthorized',
      '403 Forbidden',
      'Not logged in. Please run /login to continue.',
      'API key missing',
    ];
    for (const text of auth) {
      expect(classifyEngineFailure(text), text).toBe('engine-auth');
    }
  });

  it('classifies transient upstream blips as transient, not exhaustion', () => {
    const transient = [
      'API Error: The socket connection was closed unexpectedly',
      '529 overloaded_error',
      '429 Too Many Requests',
      'rate limit exceeded, please retry',
      'ETIMEDOUT',
      '503 Service Unavailable',
      // Our own one-shot harness wording when we kill a wedged CLI.
      'Timed out after 15 minutes',
    ];
    for (const text of transient) {
      expect(classifyEngineFailure(text), text).toBe('transient');
    }
  });

  it('classifies failures another engine cannot fix as permanent', () => {
    const permanent = [
      'prompt is too long: 250000 tokens > 200000 maximum',
      'Reached max turns (30)',
      'Response blocked by content policy',
      'HTTP 422 Unprocessable Entity',
    ];
    for (const text of permanent) {
      expect(classifyEngineFailure(text), text).toBe('permanent');
    }
  });

  it('treats unrecognized and empty errors as unknown', () => {
    expect(classifyEngineFailure('claude-code exited with code 1')).toBe('unknown');
    expect(classifyEngineFailure('')).toBe('unknown');
    expect(classifyEngineFailure(null)).toBe('unknown');
  });

  it('does not read a filesystem EACCES as a provider auth failure', () => {
    // Guards against failing over (and burning a second engine's quota) on a
    // chmod problem inside the run.
    expect(classifyEngineFailure('EACCES: permission denied, open /etc/hosts')).toBe('unknown');
  });

  it('prefers permanent over usage when both appear', () => {
    expect(classifyEngineFailure('usage limit reached: prompt is too long')).toBe('permanent');
  });
});

describe('planEngineFailover', () => {
  it('switches immediately on usage exhaustion, following the chain order', () => {
    const plan = planEngineFailover({
      errorText: 'Claude AI usage limit reached',
      currentEngine: 'claude-code',
      availability: availability({ 'codex-cli': true, 'cursor-agent': true, 'grok-cli': true }),
    });
    expect(plan).toMatchObject({
      failover: true,
      trigger: 'usage-exhausted',
      fromEngine: 'claude-code',
      toEngine: 'codex-cli',
    });
  });

  it('skips unavailable engines and picks the next one down the chain', () => {
    const plan = planEngineFailover({
      errorText: 'usage limit reached',
      currentEngine: 'claude-code',
      availability: availability({ 'cursor-agent': true }),
    });
    expect(plan).toMatchObject({ failover: true, toEngine: 'cursor-agent' });
  });

  it('honours the codex-first chain when codex is the failing engine', () => {
    const plan = planEngineFailover({
      errorText: "You've reached your weekly limit",
      currentEngine: 'codex-cli',
      availability: availability({ 'claude-code': true, 'grok-cli': true, 'cursor-agent': true }),
    });
    expect(plan).toMatchObject({ failover: true, toEngine: 'claude-code' });
  });

  it('honours the grok-first chain', () => {
    const plan = planEngineFailover({
      errorText: 'insufficient credits',
      currentEngine: 'grok-cli',
      availability: availability({ 'codex-cli': true, 'cursor-agent': true }),
    });
    expect(plan).toMatchObject({ failover: true, toEngine: 'codex-cli' });
  });

  it('honours the cursor-first chain', () => {
    const plan = planEngineFailover({
      errorText: '401 Unauthorized',
      currentEngine: 'cursor-agent',
      availability: availability({ 'grok-cli': true, 'claude-code': true }),
    });
    expect(plan).toMatchObject({ failover: true, trigger: 'engine-auth', toEngine: 'claude-code' });
  });

  it('retries the same engine first on a transient blip', () => {
    const plan = planEngineFailover({
      errorText: 'API Error: The socket connection was closed unexpectedly',
      currentEngine: 'claude-code',
      transientRetries: 0,
      availability: availability({ 'codex-cli': true }),
    });
    expect(plan).toEqual({ failover: false, reason: 'retry-first', kind: 'transient' });
  });

  it('switches engines once the same-engine transient retries are spent', () => {
    const plan = planEngineFailover({
      errorText: 'API Error: The socket connection was closed unexpectedly',
      currentEngine: 'claude-code',
      transientRetries: TRANSIENT_TURN_ERROR_MAX_RETRIES,
      availability: availability({ 'codex-cli': true }),
    });
    expect(plan).toMatchObject({
      failover: true,
      trigger: 'transient-exhausted',
      toEngine: 'codex-cli',
    });
  });

  it('never switches on permanent or unknown failures', () => {
    for (const errorText of ['prompt is too long', 'claude-code exited with code 1']) {
      expect(
        planEngineFailover({
          errorText,
          currentEngine: 'claude-code',
          availability: availability({ 'codex-cli': true, 'grok-cli': true }),
        }),
      ).toMatchObject({ failover: false, reason: 'not-failoverable' });
    }
  });

  it('does not ping-pong back to an engine already tried in this chain', () => {
    const plan = planEngineFailover({
      errorText: 'usage limit reached',
      currentEngine: 'codex-cli',
      triedEngines: ['claude-code'],
      availability: availability({ 'claude-code': true, 'grok-cli': true }),
    });
    expect(plan).toMatchObject({ failover: true, toEngine: 'grok-cli' });
    if (plan.failover) expect(plan.tried.sort()).toEqual(['claude-code', 'codex-cli']);
  });

  it('reports no-engine-available when every candidate is tried or unavailable', () => {
    const plan = planEngineFailover({
      errorText: 'usage limit reached',
      currentEngine: 'claude-code',
      triedEngines: ['codex-cli'],
      availability: availability({ 'codex-cli': true }),
    });
    expect(plan).toEqual({
      failover: false,
      reason: 'no-engine-available',
      kind: 'usage-exhausted',
      trigger: 'usage-exhausted',
    });
  });

  it('does not select the engine that just failed even if it probes available', () => {
    const plan = planEngineFailover({
      errorText: 'usage limit reached',
      currentEngine: 'claude-code',
      availability: availability({ 'claude-code': true }),
    });
    expect(plan).toMatchObject({ failover: false, reason: 'no-engine-available' });
  });
});

describe('notices', () => {
  it('names the failed engine, the error, and the substitute engine + model', () => {
    const notice = buildEngineFailoverNotice({
      trigger: 'usage-exhausted',
      fromEngine: 'claude-code',
      fromModel: 'claude-sonnet-4-6',
      toEngine: 'codex-cli',
      toModel: 'gpt-5-codex',
      errorText: 'Claude AI usage limit reached',
    });
    expect(notice).toContain('Claude Code');
    expect(notice).toContain('claude-sonnet-4-6');
    expect(notice).toContain('Codex');
    expect(notice).toContain('gpt-5-codex');
    expect(notice).toContain('ran out of usage quota');
    expect(notice).toContain('Claude AI usage limit reached');
  });

  it('explains why nothing could take over', () => {
    const notice = buildNoFailoverEngineNotice(
      'usage-exhausted',
      'claude-code',
      availability({ 'claude-code': true }),
    );
    expect(notice).toContain('no fallback engine is available');
    expect(notice).toContain('Codex');
    expect(notice).toContain('Grok');
    expect(notice).toContain('Cursor Agent');
    expect(notice).not.toContain('Gemini');
  });
});

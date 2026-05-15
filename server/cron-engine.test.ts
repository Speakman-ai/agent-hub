import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CronRow, Project } from './types.js';
import { DEFAULT_CRON_ENGINE, isSupportedEngine, resolveCronEngine } from './cron-engine.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `resolveCronEngine` is the single point of truth for "which engine does
 * this cron want to run under?". The same function is consumed by:
 *
 *   - `runCronJob` — picks the `preferred` engine handed to
 *     `resolveOneShotEngine`, so a Cursor cron actually tries Cursor first
 *     before falling back to whatever else is authed.
 *   - `routes/crons.ts` — picks the engine to validate `model` against on
 *     POST/PUT, so the API rejects a Claude id on a Cursor cron up front.
 *   - `routes/config.ts` — same model-validation pivot for project /
 *     v1-agents config import.
 *
 * The tests below cover the three branches of the resolver in priority
 * order plus the `claude-code` legacy fallback.
 */
describe('resolveCronEngine', () => {
  const claudeAgent = { id: 'claude-agent', engine: 'claude-code' };
  const cursorAgent = { id: 'cursor-agent-id', engine: 'cursor-agent' };
  const codexAgent = { id: 'codex-agent', engine: 'codex-cli' };

  function projectWith(agents: Array<{ id: string; engine: string }>): Project {
    return { id: 'p1', agents } as unknown as Project;
  }

  it("uses the cron row's explicit engine when it is a supported id", () => {
    const cron = { engine: 'cursor-agent', skill_principal_agent_id: null } as CronRow;
    const project = projectWith([claudeAgent]); // principal would say claude
    expect(resolveCronEngine(cron, project)).toBe('cursor-agent');
  });

  it("falls back to the skill principal agent's engine when cron.engine is null", () => {
    const cron = { engine: null, skill_principal_agent_id: cursorAgent.id } as CronRow;
    const project = projectWith([claudeAgent, cursorAgent]);
    expect(resolveCronEngine(cron, project)).toBe('cursor-agent');
  });

  it('inherits from the sole-agent fallback when no explicit principal is set', () => {
    // Single-agent project ⇒ resolveCronSkillPrincipalAgentId returns that agent
    const cron = { engine: null, skill_principal_agent_id: null } as CronRow;
    const project = projectWith([codexAgent]);
    expect(resolveCronEngine(cron, project)).toBe('codex-cli');
  });

  it('returns DEFAULT_CRON_ENGINE (claude-code) when project is null', () => {
    const cron = { engine: null, skill_principal_agent_id: null } as CronRow;
    expect(resolveCronEngine(cron, null)).toBe(DEFAULT_CRON_ENGINE);
    expect(DEFAULT_CRON_ENGINE).toBe('claude-code');
  });

  it('returns DEFAULT_CRON_ENGINE when multi-agent project cannot resolve a principal', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cron = { engine: null, skill_principal_agent_id: null } as CronRow;
    const project = projectWith([claudeAgent, cursorAgent]);
    expect(resolveCronEngine(cron, project)).toBe(DEFAULT_CRON_ENGINE);
  });

  it('ignores a cron.engine value that is not in ALL_SUPPORTED_ENGINES', () => {
    // The API normalizer rejects this on write, but defensive callers (DB
    // rows older than the migration, hand-edited rows) still flow through
    // the resolver — falling through to principal/default keeps runs alive.
    const cron = { engine: 'made-up-engine', skill_principal_agent_id: null } as unknown as CronRow;
    const project = projectWith([cursorAgent]);
    expect(resolveCronEngine(cron, project)).toBe('cursor-agent');
  });

  it('falls through to default when principal agent has an unsupported engine', () => {
    const weirdAgent = { id: 'weird', engine: 'not-a-real-engine' };
    const cron = { engine: null, skill_principal_agent_id: 'weird' } as CronRow;
    const project = projectWith([weirdAgent]);
    expect(resolveCronEngine(cron, project)).toBe(DEFAULT_CRON_ENGINE);
  });
});

describe('isSupportedEngine', () => {
  it('accepts each ALL_SUPPORTED_ENGINES id', () => {
    for (const id of ['claude-code', 'cursor-agent', 'codex-cli', 'gemini-cli']) {
      expect(isSupportedEngine(id)).toBe(true);
    }
  });
  it('rejects unknown ids and non-strings', () => {
    expect(isSupportedEngine('not-real')).toBe(false);
    expect(isSupportedEngine('')).toBe(false);
    expect(isSupportedEngine(null)).toBe(false);
    expect(isSupportedEngine(undefined)).toBe(false);
    expect(isSupportedEngine(123)).toBe(false);
  });
});

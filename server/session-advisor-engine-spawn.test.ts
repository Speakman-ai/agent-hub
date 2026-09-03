/**
 * Spawn-path spec for the per-advisor engine override.
 *
 * The reviewer flagged that the earlier test only proved
 * `materializeSessionAdvisors` copies the override onto `sessionEngine`; it
 * never exercised the resolver or proved the selected CLI actually runs. This
 * file closes that gap end-to-end for the pure seam the spawn uses:
 *
 *   1. `resolveAdvisorEngineAndModel` — the SINGLE resolver both the runtime
 *      spawn (`runAdvisorTurn`) and the reported roster (`listSessionAgents`)
 *      call — applies participant override → per-user override → agent engine.
 *   2. The resolved engine is fed into `buildSessionMultiSpawnArgs`, and we
 *      assert the produced `bin` is the CLI for that engine — i.e. the selected
 *      CLI genuinely receives the explicit engine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserPreferencesRow = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('./user-preferences-store.js', () => ({ getUserPreferencesRow }));

const { resolveAdvisorEngineAndModel, buildSessionMultiSpawnArgs } =
  await import('./session-multi-engine.js');
const { default: config } = await import('./config.js');

const bins = {
  claude: '/bin/claude',
  cursor: '/bin/cursor',
  gemini: '/bin/gemini',
  codex: '/bin/codex',
  grok: '/bin/grok',
};

function spawnBinFor(engine: string, model: string): string {
  return buildSessionMultiSpawnArgs({
    engine,
    model,
    systemPrompt: 'sys',
    userPrompt: 'user',
    bins,
    advisory: true,
    // cursor-agent requires a chat id; harmless for other engines.
    cursorChatId: 'chat-1',
  }).bin;
}

describe('resolveAdvisorEngineAndModel → spawn', () => {
  beforeEach(() => {
    getUserPreferencesRow.mockReset();
    getUserPreferencesRow.mockReturnValue({});
  });

  it('inherits the agent engine when there is no override, and spawns that CLI', () => {
    const { engine, model } = resolveAdvisorEngineAndModel(config, {
      agentId: 'advisor-agent',
      agentEngine: 'claude-code',
      sessionEngine: null,
      ownerUserId: 'user-1',
    });
    expect(engine).toBe('claude-code');
    expect(spawnBinFor(engine, model)).toBe(bins.claude);
  });

  it('applies the per-user engine override when the participant has none', () => {
    // This is the exact case the reviewer flagged: reported/spawned engine must
    // both be the per-user override, not the agent's configured Claude.
    getUserPreferencesRow.mockReturnValue({
      agentEngineOverrides: { 'advisor-agent': { engine: 'cursor-agent' } },
    });
    const { engine, model } = resolveAdvisorEngineAndModel(config, {
      agentId: 'advisor-agent',
      agentEngine: 'claude-code',
      sessionEngine: null,
      ownerUserId: 'user-1',
    });
    expect(engine).toBe('cursor-agent');
    expect(spawnBinFor(engine, model)).toBe(bins.cursor);
  });

  it('lets the participant engine override win over the per-user override', () => {
    getUserPreferencesRow.mockReturnValue({
      agentEngineOverrides: { 'advisor-agent': { engine: 'cursor-agent' } },
    });
    const { engine, model } = resolveAdvisorEngineAndModel(config, {
      agentId: 'advisor-agent',
      agentEngine: 'claude-code',
      sessionEngine: 'codex-cli',
      ownerUserId: 'user-1',
    });
    expect(engine).toBe('codex-cli');
    expect(spawnBinFor(engine, model)).toBe(bins.codex);
  });
});

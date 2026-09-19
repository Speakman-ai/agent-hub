import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Prod 2026-09-19: an uncaught EngineAuthRequiredError in runAdvisorTurn
 * exited Node (unhandledRejection) and ALB 502'd the Hub. These contracts
 * keep the throw inside the round instead of on the process.
 */
describe('multi-agent advisor auth must not crash the Hub process', () => {
  const multi = readFileSync(path.join(import.meta.dirname, 'session-multi-agent.ts'), 'utf8');
  const chat = readFileSync(path.join(import.meta.dirname, 'chat.ts'), 'utf8');
  const sessions = readFileSync(path.join(import.meta.dirname, 'routes/sessions.ts'), 'utf8');

  it('catches resolveSessionCliSpawnEnv failures before the spawn Promise', () => {
    const idx = multi.indexOf('resolveSessionCliSpawnEnv({');
    expect(idx).toBeGreaterThan(-1);
    const window = multi.slice(Math.max(0, idx - 250), idx + 900);
    expect(window).toContain('try {');
    expect(window).toContain('EngineAuthRequiredError');
    expect(window).toContain('persistAdvisorFailure');
    expect(window).toContain('return;');
  });

  it('absorbs leftover round throws instead of rejecting handleMultiAgentChat', () => {
    expect(multi).toContain('[multi-agent] round failed session=');
    expect(multi).toContain("d.broadcast({ type: 'error', sessionId, error: errMsg })");
  });

  it('handleChat does not let handleMultiAgentChat reject', () => {
    const idx = chat.indexOf('await handleMultiAgentChat(ws, msg)');
    expect(idx).toBeGreaterThan(-1);
    const window = chat.slice(Math.max(0, idx - 80), idx + 450);
    expect(window).toContain('try {');
    expect(window).toContain('handleMultiAgentChat rejected');
  });

  it('HTTP kickoff paths catch handleChat so a throw cannot exit Node', () => {
    expect(sessions).toContain('[tasks] handleChat rejected');
    expect(sessions).toContain('[forward] handleChat rejected');
    expect(sessions).toContain('[follow-up] handleChat rejected');
    expect(sessions).toContain('[sessions] model-change handleChat rejected');
  });
});

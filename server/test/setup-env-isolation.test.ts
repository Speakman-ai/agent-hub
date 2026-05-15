/**
 * Guardrail: test/setup.ts must strip deploy-bootstrap env vars before the
 * server module graph loads. Hosts (Agent Hub worker shells, Docker) often
 * export AGENT_HUB_DEFAULT_PASSWORD / AGENT_HUB_PUBLIC_URL; leaving them in
 * place provisions auth.json or wins over test config.json, breaking supertest
 * fixtures (401s or wrong webhook base URLs).
 */
import './setup.js';
import { describe, it, expect } from 'vitest';

describe('test/setup env isolation', () => {
  it('clears bootstrap / URL env vars so server boot matches fixture config', () => {
    expect(process.env.AGENT_HUB_DEFAULT_PASSWORD).toBeUndefined();
    expect(process.env.AGENT_HUB_DEFAULT_USERNAME).toBeUndefined();
    expect(process.env.AGENT_HUB_PUBLIC_URL).toBeUndefined();
    expect(process.env.AGENT_HUB_AGENT_URL).toBeUndefined();
  });
});

/**
 * Regression test for the codex engine-switch bug.
 *
 * Symptom (from the browser console): after clicking "codex-cli" in the
 * TopBar engine picker, the session's engine was updated but its `model`
 * field still held the previous Claude model (e.g. `claude-opus-4-8`).
 * The client would then fire `PUT /api/sessions/:id/model` with that
 * stale Claude model and the server correctly rejected it with:
 *
 *   400  Model "claude-opus-4-8" is not valid for engine "codex-cli".
 *        Allowed: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2
 *
 * Fix: when `PUT /api/sessions/:id/engine` switches to an engine whose
 * allowlist does not contain the session's current model, the server
 * resets the `model` column to `defaultModelForEngine(engine)` so the
 * session is never left in a mixed/invalid state.
 *
 * The reset model is the first capability-resolved Codex model when the
 * configured Luna default is not advertised by the installed CLI.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'engine-reset-agent',
    name: 'Engine Reset Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

describe('PUT /api/sessions/:id/engine — model reset semantics', () => {
  it('resets model to the new engine default when the current model is not valid for the new engine', async () => {
    const session = await createSession({ agentId, name: 'claude→codex' });
    const sessionId = session.id as string;

    // Pin the session to a Claude model first so we have a concrete
    // "will be invalid after switch" state to assert against.
    const pinned = await request
      .put(`/api/sessions/${sessionId}/model`)
      .send({ model: 'claude-opus-4-8' })
      .expect(200);
    expect(pinned.body.engine).toBe('claude-code');
    expect(pinned.body.model).toBe('claude-opus-4-8');

    // Switch to codex-cli. The server must notice that `claude-opus-4-8`
    // is not in the codex allowlist and reset the model field.
    const switched = await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'codex-cli' })
      .expect(200);
    expect(switched.body.engine).toBe('codex-cli');
    expect(switched.body.model).toBeTruthy();

    // Sanity check: a subsequent `PUT .../model` with the reset-to value
    // round-trips cleanly (the client no longer has a stale mismatched
    // model to send, but if it replays the session's current model the
    // server accepts it).
    const replay = await request
      .put(`/api/sessions/${sessionId}/model`)
      .send({ model: switched.body.model })
      .expect(200);
    expect(replay.body.model).toBe(switched.body.model);
  });

  it('preserves the model on a same-engine PUT (no unnecessary reset)', async () => {
    // A redundant engine PUT should never clobber the user's model
    // selection. Validate the no-op path by switching to the same engine.
    const session = await createSession({ agentId, name: 'claude→claude' });
    const sessionId = session.id as string;

    await request
      .put(`/api/sessions/${sessionId}/model`)
      .send({ model: 'claude-sonnet-5' })
      .expect(200);

    const switched = await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'claude-code' })
      .expect(200);
    expect(switched.body.engine).toBe('claude-code');
    // Model is still valid for the (unchanged) engine, so the server
    // must leave it alone — not reset to the engine default.
    expect(switched.body.model).toBe('claude-sonnet-5');
  });

  it('resets a null model to the engine default on engine switch', async () => {
    // Covers the `!existing.model` branch — a freshly created session
    // with no pinned model should get the engine's default on first
    // engine PUT rather than staying null.
    const session = await createSession({ agentId, name: 'null-model' });
    const sessionId = session.id as string;
    // Don't pin any model — the session starts with model=null.

    const switched = await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'codex-cli' })
      .expect(200);
    expect(switched.body.engine).toBe('codex-cli');
    expect(switched.body.model).toBeTruthy();
  });

  it('returns 404 when the session does not exist (no silent model write)', async () => {
    await request
      .put('/api/sessions/does-not-exist/engine')
      .send({ engine: 'codex-cli' })
      .expect(404);
  });

  it('rejects an invalid engine name before touching any row', async () => {
    const session = await createSession({ agentId, name: 'bad-engine' });
    const sessionId = session.id as string;

    await request
      .put(`/api/sessions/${sessionId}/engine`)
      .send({ engine: 'not-a-real-engine' })
      .expect(400);

    // Session is untouched — engine should still be the default set on
    // creation (claude-code from the agent fixture).
    const after = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(after.body.engine).toBe('claude-code');
  });
});

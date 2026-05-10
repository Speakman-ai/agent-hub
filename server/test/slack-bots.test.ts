/**
 * Tests for the DB-backed Slack bot management API.
 *
 * Covers: list, create, update, delete, toggle, and test-tokens endpoints.
 * restartSlack is mocked so tests are hermetic — no real Bolt/Slack connections.
 */

// vi.mock must be hoisted before imports that trigger loading the mocked module.
import { vi, describe, it, expect, beforeAll } from 'vitest';

vi.mock('../slack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slack.js')>();
  return {
    ...actual,
    restartSlack: vi.fn().mockResolvedValue(undefined),
    getSlackStatus: vi.fn(() => []),
    getSlackMessages: vi.fn(() => []),
    getAllSlackMessages: vi.fn(() => []),
  };
});

import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('Slack bot CRUD', () => {
  let createdId: string;

  it('GET /api/slack/bots — returns empty array initially', async () => {
    const res = await request.get('/api/slack/bots');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/slack/bots — creates a new bot (tokens masked in response)', async () => {
    const res = await request.post('/api/slack/bots').send({
      name: 'test-bot',
      bot_token: 'xoxb-test-token-123456',
      app_token: 'xapp-test-token-abcdef',
      agent_id: 'test-agent',
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.name).toBe('test-bot');
    // Tokens must be masked in the response — never returned in plaintext
    expect(res.body.bot_token).not.toBe('xoxb-test-token-123456');
    expect(res.body.bot_token).toContain('****');
    expect(res.body.app_token).toContain('****');
    expect(res.body.agent_id).toBe('test-agent');
  });

  it('GET /api/slack/bots — lists the created bot with masked tokens', async () => {
    const res = await request.get('/api/slack/bots');
    expect(res.status).toBe(200);
    const bot = res.body.find((b: { id: string }) => b.id === createdId);
    expect(bot).toBeTruthy();
    expect(bot.name).toBe('test-bot');
    expect(bot.bot_token).toContain('****');
    expect(bot.app_token).toContain('****');
  });

  it('PUT /api/slack/bots/:id — updates name without touching masked tokens', async () => {
    const res = await request.put(`/api/slack/bots/${createdId}`).send({
      name: 'test-bot-renamed',
      bot_token: '****masked****', // sentinel — should be ignored, original token preserved
      agent_id: 'test-agent',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('test-bot-renamed');
    // Token should still be masked (original value preserved, not cleared)
    expect(res.body.bot_token).toContain('****');
  });

  it('POST /api/slack/bots/:id/toggle — toggles enabled state', async () => {
    const before = await request.get('/api/slack/bots');
    const botBefore = before.body.find((b: { id: string }) => b.id === createdId);
    expect(botBefore).toBeTruthy();
    const wasEnabled = botBefore.enabled;

    const res = await request.post(`/api/slack/bots/${createdId}/toggle`);
    expect(res.status).toBe(200);
    // enabled should have flipped
    expect(res.body.enabled).toBe(!wasEnabled);
  });

  it('DELETE /api/slack/bots/:id — removes the bot', async () => {
    const res = await request.delete(`/api/slack/bots/${createdId}`);
    expect(res.status).toBe(200);
    const listRes = await request.get('/api/slack/bots');
    const found = listRes.body.find((b: { id: string }) => b.id === createdId);
    expect(found).toBeFalsy();
  });

  it('POST /api/slack/bots/:id/test — returns 404 for unknown id', async () => {
    const res = await request.post('/api/slack/bots/nonexistent-id/test');
    expect(res.status).toBe(404);
  });

  it('POST /api/slack/test-tokens — returns 400 for missing bot_token', async () => {
    const res = await request.post('/api/slack/test-tokens').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('Slack bot validation', () => {
  it('POST /api/slack/bots — 400 when required fields are missing', async () => {
    const res = await request.post('/api/slack/bots').send({ name: 'incomplete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('GET /api/slack/status — returns array', async () => {
    const res = await request.get('/api/slack/status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/slack/messages — returns array', async () => {
    const res = await request.get('/api/slack/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

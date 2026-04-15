import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/config/claude-auth/callback', () => {
  it('returns 400 when code is missing', async () => {
    const res = await request.post('/api/config/claude-auth/callback').send({}).expect(400);
    expect(res.body.error).toMatch(/code is required/);
  });

  it('returns 400 when code is not a string', async () => {
    const res = await request
      .post('/api/config/claude-auth/callback')
      .send({ code: 123 })
      .expect(400);
    expect(res.body.error).toMatch(/code is required/);
  });

  it('returns 409 when no login is in progress', async () => {
    const res = await request
      .post('/api/config/claude-auth/callback')
      .send({ code: 'https://console.anthropic.com/oauth/callback?code=abc123' })
      .expect(409);
    expect(res.body.error).toMatch(/No login in progress/);
  });
});

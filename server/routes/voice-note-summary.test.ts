import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const { default: createVoiceNoteSummaryRoutes } = await import('./voice-note-summary.js');
const { NoEnginesAvailableError } = await import('../engine-resolver.js');

function mount(authUserId: string | null, summarize: any) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) Object.assign(req, { authUserId });
    next();
  });
  app.use(createVoiceNoteSummaryRoutes({ config: {} } as RouteDeps, { summarize }));
  return app;
}

describe('POST /api/transcribe/summary', () => {
  it('requires authentication', async () => {
    await request(mount(null, vi.fn())).post('/api/transcribe/summary').send({}).expect(401);
  });

  it('rejects an empty transcript without running a model', async () => {
    const summarize = vi.fn();
    const res = await request(mount('u1', summarize))
      .post('/api/transcribe/summary')
      .send({ transcript: '   ' })
      .expect(400);
    expect(res.body.error).toMatch(/transcript/);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("summarizes for the caller and returns the model's markdown", async () => {
    const summarize = vi.fn(async () => ({ summary: '**Gist.**', engine: 'e', model: 'm' }));
    const res = await request(mount('u1', summarize))
      .post('/api/transcribe/summary')
      .send({ transcript: ' hi ' })
      .expect(200);
    expect(res.body).toEqual({ summary: '**Gist.**', engine: 'e', model: 'm' });
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', transcript: 'hi' }),
    );
  });

  it('maps no-engine and generic failures', async () => {
    const none = vi.fn(async () => {
      throw new NoEnginesAvailableError({} as any);
    });
    await request(mount('u1', none))
      .post('/api/transcribe/summary')
      .send({ transcript: 'x' })
      .expect(503);
    const fail = vi.fn(async () => {
      throw new Error('all engines died');
    });
    const res = await request(mount('u1', fail))
      .post('/api/transcribe/summary')
      .send({ transcript: 'x' })
      .expect(502);
    expect(res.body.error).toBe('all engines died');
  });
});

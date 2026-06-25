import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

async function createEpic(name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name, description: '', color: '#6366F1' })
    .expect(200);
  return (res.body as { id: string }).id;
}

describe('Phase autonomous defaults', () => {
  it('arms a freshly created phase for auto-dispatch and Auto Merge by default', async () => {
    const epicId = await createEpic('Phase Defaults Epic');
    const res = await request
      .post(`/api/projects/${projectId}/board/phases`)
      .send({ epicId, name: 'Phase 1', description: '' })
      .expect(200);

    const phase = res.body as {
      autonomous?: number;
      autonomous_send_it?: number;
      autonomous_running?: number;
    };
    // Armed (so the sequential cascade advances into it) ...
    expect(phase.autonomous).toBe(1);
    // ... and Auto Merge on (so dispatched tickets merge, cards reach Done, and
    // the phase actually "completes" instead of stalling on stacked PRs).
    expect(phase.autonomous_send_it).toBe(1);
    // But not running — arming must never spontaneously start dispatch; that
    // only happens via Run phase or the auto-advance cascade.
    expect(phase.autonomous_running ?? 0).toBe(0);
  });

  it('persists an Auto Merge opt-out (autonomous_send_it 1 -> 0) across reload', async () => {
    const epicId = await createEpic('Phase Opt-Out Epic');
    const created = await request
      .post(`/api/projects/${projectId}/board/phases`)
      .send({ epicId, name: 'Phase Opt-Out', description: '' })
      .expect(200);
    const phaseId = (created.body as { id: string }).id;
    expect((created.body as { autonomous_send_it: number }).autonomous_send_it).toBe(1);

    // Opt out of Auto Merge while keeping auto-dispatch on — mirrors the body the
    // client's phaseFormToUpdateBody sends when the toggle is switched off.
    const saved = await request
      .put(`/api/projects/${projectId}/board/phases/${phaseId}`)
      .send({
        name: 'Phase Opt-Out',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 1,
        autonomousSendIt: 0,
      })
      .expect(200);
    expect((saved.body as { autonomous_send_it: number }).autonomous_send_it).toBe(0);

    // Reload (fresh GET) — the opt-out must stick, not snap back to the default.
    const reloaded = await request.get(`/api/projects/${projectId}/board/phases`).expect(200);
    const phase = (reloaded.body as Array<{ id: string; autonomous_send_it: number }>).find(
      (p) => p.id === phaseId,
    );
    expect(phase?.autonomous_send_it).toBe(0);

    // And it can be turned back on.
    const reEnabled = await request
      .put(`/api/projects/${projectId}/board/phases/${phaseId}`)
      .send({
        name: 'Phase Opt-Out',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 1,
        autonomousSendIt: 1,
      })
      .expect(200);
    expect((reEnabled.body as { autonomous_send_it: number }).autonomous_send_it).toBe(1);
  });
});

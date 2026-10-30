import { describe, expect, it } from 'vitest';
import { qaSessionControl, type QaSessionStateWire } from './qaSessionRequest';

const env = { id: 'e1', name: 'Staging', baseUrl: 'https://s.example.com' };
const base: QaSessionStateWire = {
  request: null,
  merged: false,
  defaultEnvironment: env,
  delayMinutes: 10,
  hasQaAgent: true,
};
const req = (over: Partial<NonNullable<QaSessionStateWire['request']>>) => ({
  sessionId: 's',
  projectId: 'p',
  status: 'armed' as const,
  planId: null,
  planTitle: null,
  runId: null,
  dueAt: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('qaSessionControl', () => {
  it('is an unchecked checkbox before merge', () => {
    const c = qaSessionControl(base);
    expect(c).toMatchObject({ kind: 'checkbox', checked: false, blocked: null, planId: null });
    expect(c.title).toContain('Staging, 10 min after merge');
  });

  it('is checked while armed', () => {
    expect(qaSessionControl({ ...base, request: req({}) }).checked).toBe(true);
  });

  it('is a button after merge and links the plan', () => {
    const c = qaSessionControl(
      {
        ...base,
        merged: true,
        request: req({ status: 'waiting', planId: 'plan-1', dueAt: '2026-01-01T00:05:00Z' }),
      },
      Date.parse('2026-01-01T00:00:00Z'),
    );
    expect(c).toMatchObject({ kind: 'button', busy: true, planId: 'plan-1' });
    expect(c.status).toBe('QA run starts in 5 min');
  });

  it('explains why it is blocked', () => {
    expect(qaSessionControl({ ...base, defaultEnvironment: null }).blocked).toMatch(/Default/);
    expect(qaSessionControl({ ...base, hasQaAgent: false }).blocked).toMatch(/no QA agent/);
  });

  it('shows the failure reason', () => {
    const c = qaSessionControl({
      ...base,
      merged: true,
      request: req({ status: 'failed', error: 'no cases' }),
    });
    expect(c.status).toBe('QA failed: no cases');
    expect(c.busy).toBe(false);
  });

  it('keeps an armed checkbox untickable when prerequisites disappear', () => {
    const armed = qaSessionControl({ ...base, defaultEnvironment: null, request: req({}) });
    expect(armed).toMatchObject({ kind: 'checkbox', checked: true, enabled: true });
    expect(armed.title).toMatch(/Untick to cancel/);
    expect(qaSessionControl({ ...base, defaultEnvironment: null }).enabled).toBe(false);
    expect(qaSessionControl({ ...base, merged: true, hasQaAgent: false }).enabled).toBe(false);
  });

  it('stays busy while the run is launching', () => {
    const c = qaSessionControl({ ...base, merged: true, request: req({ status: 'launching' }) });
    expect(c).toMatchObject({ busy: true, enabled: false, status: 'QA run starting' });
  });
});

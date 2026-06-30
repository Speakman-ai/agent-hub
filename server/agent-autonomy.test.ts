import { describe, it, expect } from 'vitest';
import {
  agentAcceptsAutonomousTickets,
  isAutonomyLocked,
  isAutonomyLockedOff,
  isAutonomyLockedOn,
} from './agent-autonomy.js';

describe('agent-autonomy — lock detection', () => {
  it('locks ON for default Dev roles (dev/lead)', () => {
    expect(isAutonomyLockedOn({ role: 'dev' })).toBe(true);
    expect(isAutonomyLockedOn({ role: 'lead' })).toBe(true);
    expect(isAutonomyLockedOn({ role: 'DEV' })).toBe(true); // case-insensitive
    expect(isAutonomyLockedOn({ role: 'sub' })).toBe(false);
    expect(isAutonomyLockedOn({ role: undefined })).toBe(false);
  });

  it('locks OFF for out-of-band roles (docs/reviewer/skill-builder)', () => {
    expect(isAutonomyLockedOff({ role: 'docs' })).toBe(true);
    expect(isAutonomyLockedOff({ role: 'reviewer' })).toBe(true);
    // Regression: the Skill Builder coach must not default to Dev-on.
    expect(isAutonomyLockedOff({ role: 'skill-builder' })).toBe(true);
    expect(isAutonomyLockedOff({ role: 'SKILL-BUILDER' })).toBe(true); // case-insensitive
    expect(isAutonomyLockedOff({ role: 'dev' })).toBe(false);
    // Regression: the retired `intake` role is no longer special — it is not
    // locked off (the intake agent + its dispatch paths have been scrubbed).
    expect(isAutonomyLockedOff({ role: 'intake' })).toBe(false);
  });

  it('isAutonomyLocked is the union of locked-on and locked-off', () => {
    expect(isAutonomyLocked({ role: 'dev' })).toBe(true);
    expect(isAutonomyLocked({ role: 'reviewer' })).toBe(true);
    expect(isAutonomyLocked({ role: 'sub' })).toBe(false);
    expect(isAutonomyLocked({ role: 'frontend' })).toBe(false);
    expect(isAutonomyLocked({})).toBe(false);
  });
});

describe('agent-autonomy — effective eligibility', () => {
  it('always accepts default Dev roles, ignoring isDev', () => {
    expect(agentAcceptsAutonomousTickets({ role: 'dev', isDev: false })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'lead', isDev: false })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'dev' })).toBe(true);
  });

  it('never accepts out-of-band roles, ignoring isDev', () => {
    expect(agentAcceptsAutonomousTickets({ role: 'docs', isDev: true })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ role: 'reviewer', isDev: true })).toBe(false);
    // Regression: skill-builder is a coach, never an autonomous-ticket recipient,
    // even when its (pre-flag) isDev is undefined or explicitly true.
    expect(agentAcceptsAutonomousTickets({ role: 'skill-builder', isDev: true })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ role: 'skill-builder' })).toBe(false);
  });

  it('honours explicit isDev for togglable roles', () => {
    expect(agentAcceptsAutonomousTickets({ role: 'sub', isDev: true })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'sub', isDev: false })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ role: 'frontend', isDev: false })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ isDev: true })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ isDev: false })).toBe(false);
  });

  it('treats undefined isDev as eligible (pre-flag backward compat)', () => {
    expect(agentAcceptsAutonomousTickets({ role: 'sub' })).toBe(true);
    expect(agentAcceptsAutonomousTickets({})).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'frontend' })).toBe(true);
  });

  it('returns false for nullish input', () => {
    expect(agentAcceptsAutonomousTickets(null)).toBe(false);
    expect(agentAcceptsAutonomousTickets(undefined)).toBe(false);
  });
});

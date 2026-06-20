import { describe, it, expect } from 'vitest';
import {
  agentAcceptsAutonomousTickets,
  isAutonomyLocked,
  isAutonomyLockedOff,
  isAutonomyLockedOn,
} from './agentAutonomy.js';

describe('agentAutonomy (client)', () => {
  it('locks ON default Dev roles, OFF out-of-band roles', () => {
    expect(isAutonomyLockedOn({ role: 'dev' })).toBe(true);
    expect(isAutonomyLockedOn({ role: 'lead' })).toBe(true);
    expect(isAutonomyLockedOff({ role: 'reviewer' })).toBe(true);
    expect(isAutonomyLockedOff({ role: 'intake' })).toBe(true);
    expect(isAutonomyLocked({ role: 'sub' })).toBe(false);
    expect(isAutonomyLocked({ role: 'frontend' })).toBe(false);
  });

  it('resolves effective eligibility', () => {
    expect(agentAcceptsAutonomousTickets({ role: 'dev', isDev: false })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'reviewer', isDev: true })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ role: 'sub', isDev: true })).toBe(true);
    expect(agentAcceptsAutonomousTickets({ role: 'sub', isDev: false })).toBe(false);
    expect(agentAcceptsAutonomousTickets({ role: 'sub' })).toBe(true); // undefined → eligible
    expect(agentAcceptsAutonomousTickets({ isDev: false })).toBe(false);
    expect(agentAcceptsAutonomousTickets(null)).toBe(false);
  });
});

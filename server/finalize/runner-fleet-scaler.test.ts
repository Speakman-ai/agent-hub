import { describe, it, expect } from 'vitest';
import { desiredAgents } from './runner-fleet-scaler.js';

describe('desiredAgents', () => {
  it('scales to zero (min) when the queue is empty', () => {
    expect(desiredAgents(0, 0, 8)).toBe(0);
    expect(desiredAgents(0, 1, 8)).toBe(1); // warm pool floor
  });

  it('matches agent count to queue depth between min and max', () => {
    expect(desiredAgents(1, 0, 8)).toBe(1);
    expect(desiredAgents(5, 0, 8)).toBe(5);
  });

  it('caps at max (excess jobs wait in the queue)', () => {
    expect(desiredAgents(20, 0, 8)).toBe(8);
  });

  it('never drops below the floor while work is queued', () => {
    expect(desiredAgents(2, 4, 8)).toBe(4);
  });
});

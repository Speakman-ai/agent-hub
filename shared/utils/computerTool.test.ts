import { describe, expect, it } from 'vitest';
import { resolveComputerToolEnabled } from './computerTool';

describe('resolveComputerToolEnabled', () => {
  it('is off unless the session or the agent default turns it on', () => {
    expect(resolveComputerToolEnabled(undefined, undefined)).toBe(false);
    expect(resolveComputerToolEnabled(undefined, null)).toBe(false);
    expect(resolveComputerToolEnabled(true, null)).toBe(true);
  });

  it('lets the session override the agent default either way', () => {
    expect(resolveComputerToolEnabled(undefined, 1)).toBe(true);
    expect(resolveComputerToolEnabled(true, 0)).toBe(false);
  });
});

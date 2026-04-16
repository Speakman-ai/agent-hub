import { describe, it, expect } from 'vitest';
import { resolveShouldAutoMerge } from './auto-merge.js';

describe('resolveShouldAutoMerge', () => {
  it('per-PR override=true beats project setting=false', () => {
    expect(resolveShouldAutoMerge(true, { autoMerge: false })).toBe(true);
  });

  it('per-PR override=false beats project setting=true', () => {
    expect(resolveShouldAutoMerge(false, { autoMerge: true })).toBe(false);
  });

  it('no override falls through to project setting=true', () => {
    expect(resolveShouldAutoMerge(undefined, { autoMerge: true })).toBe(true);
  });

  it('no override falls through to project setting=false', () => {
    expect(resolveShouldAutoMerge(undefined, { autoMerge: false })).toBe(false);
  });

  it('no override and no project workflow → false', () => {
    expect(resolveShouldAutoMerge(undefined, undefined)).toBe(false);
  });

  it('no override and project workflow without autoMerge key → false', () => {
    expect(resolveShouldAutoMerge(undefined, { autoMerge: undefined })).toBe(false);
  });

  it('no override and null project workflow → false', () => {
    expect(resolveShouldAutoMerge(undefined, null)).toBe(false);
  });
});

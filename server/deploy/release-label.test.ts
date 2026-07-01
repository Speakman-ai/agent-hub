import { describe, it, expect } from 'vitest';
import { deploymentReleaseLabel } from './release-label.js';

describe('deploymentReleaseLabel', () => {
  it('prefers meta.releaseVersion over everything', () => {
    const result = deploymentReleaseLabel({
      ref: 'f27b422fdeadbeef1234567890abcdef12345678',
      meta: JSON.stringify({ releaseVersion: 'v2.31.18' }),
    });
    expect(result).toEqual({ version: 'v2.31.18', label: 'v2.31.18' });
  });

  it('falls back to meta.releaseTag when releaseVersion is absent', () => {
    const result = deploymentReleaseLabel({
      ref: 'abcdef1234567890',
      meta: JSON.stringify({ releaseTag: 'v1.4.0' }),
    });
    expect(result).toEqual({ version: 'v1.4.0', label: 'v1.4.0' });
  });

  it('derives the version from a refs/tags/ ref', () => {
    const result = deploymentReleaseLabel({ ref: 'refs/tags/v2.31.18', meta: null });
    expect(result).toEqual({ version: 'v2.31.18', label: 'v2.31.18' });
  });

  it('treats a bare version-like ref as the version', () => {
    expect(deploymentReleaseLabel({ ref: 'v1.2.3', meta: null }).label).toBe('v1.2.3');
    expect(deploymentReleaseLabel({ ref: '2.31.18', meta: null }).label).toBe('2.31.18');
    expect(deploymentReleaseLabel({ ref: 'v1.2.0-rc.1', meta: null }).version).toBe('v1.2.0-rc.1');
  });

  it('falls back to the short hash for a commit SHA ref', () => {
    const result = deploymentReleaseLabel({
      ref: 'f27b422fdeadbeef1234567890abcdef12345678',
      meta: null,
    });
    expect(result).toEqual({ version: null, label: 'f27b422fdead' });
  });

  it('shows a short SHA verbatim when already short', () => {
    expect(deploymentReleaseLabel({ ref: 'f27b422', meta: null }).label).toBe('f27b422');
  });

  it('shows a non-version branch ref verbatim (not a version)', () => {
    const result = deploymentReleaseLabel({ ref: 'main', meta: null });
    expect(result).toEqual({ version: null, label: 'main' });
  });

  it('ignores malformed meta JSON and falls back to the ref', () => {
    const result = deploymentReleaseLabel({ ref: 'refs/tags/v9.9.9', meta: '{not json' });
    expect(result.label).toBe('v9.9.9');
  });

  it('ignores empty / whitespace meta version values', () => {
    const result = deploymentReleaseLabel({
      ref: 'abcdef1234567890abcdef',
      meta: JSON.stringify({ releaseVersion: '   ' }),
    });
    expect(result.version).toBeNull();
    expect(result.label).toBe('abcdef123456');
  });

  it('handles an empty ref gracefully', () => {
    expect(deploymentReleaseLabel({ ref: '', meta: null }).label).toBe('-');
  });
});

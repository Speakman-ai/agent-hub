import { describe, it, expect } from 'vitest';
import { deploymentReleaseLabel } from './deploymentReleaseLabel.js';

describe('deploymentReleaseLabel', () => {
  it('prefers meta.releaseVersion over everything (string meta)', () => {
    expect(
      deploymentReleaseLabel({
        ref: 'f27b422fdeadbeef1234567890abcdef12345678',
        meta: JSON.stringify({ releaseVersion: 'v2.31.18' }),
      }),
    ).toEqual({ version: 'v2.31.18', label: 'v2.31.18' });
  });

  it('accepts already-parsed object meta (client/mobile DTO shape)', () => {
    expect(
      deploymentReleaseLabel({ ref: 'abc123', meta: { releaseVersion: 'v9.0.0' } }).label,
    ).toBe('v9.0.0');
  });

  it('falls back to meta.releaseTag when releaseVersion is absent', () => {
    expect(
      deploymentReleaseLabel({ ref: 'abcdef1234567890', meta: { releaseTag: 'v1.4.0' } }),
    ).toEqual({ version: 'v1.4.0', label: 'v1.4.0' });
  });

  it('derives the version from a version-like refs/tags/ ref', () => {
    expect(deploymentReleaseLabel({ ref: 'refs/tags/v2.31.18', meta: null })).toEqual({
      version: 'v2.31.18',
      label: 'v2.31.18',
    });
  });

  it('treats a bare version-like ref as the version', () => {
    expect(deploymentReleaseLabel({ ref: 'v1.2.3', meta: null }).label).toBe('v1.2.3');
    expect(deploymentReleaseLabel({ ref: '2.31.18', meta: null }).label).toBe('2.31.18');
    expect(deploymentReleaseLabel({ ref: 'v1.2.0-rc.1', meta: null }).version).toBe('v1.2.0-rc.1');
  });

  it('does NOT report a non-version tag ref as a version, but strips it for the label', () => {
    // refs/tags/ prefix alone is not a version — parity with the bare-ref gate.
    expect(deploymentReleaseLabel({ ref: 'refs/tags/nightly', meta: null })).toEqual({
      version: null,
      label: 'nightly',
    });
  });

  it('falls back to the short hash for a commit SHA ref', () => {
    expect(
      deploymentReleaseLabel({ ref: 'f27b422fdeadbeef1234567890abcdef12345678', meta: null }),
    ).toEqual({ version: null, label: 'f27b422fdead' });
  });

  it('shows a short SHA verbatim when already short', () => {
    expect(deploymentReleaseLabel({ ref: 'f27b422', meta: null }).label).toBe('f27b422');
  });

  it('shows a non-version branch ref verbatim (not a version)', () => {
    expect(deploymentReleaseLabel({ ref: 'main', meta: null })).toEqual({
      version: null,
      label: 'main',
    });
  });

  it('ignores malformed meta JSON and falls back to the ref', () => {
    expect(deploymentReleaseLabel({ ref: 'refs/tags/v9.9.9', meta: '{not json' }).label).toBe(
      'v9.9.9',
    );
  });

  it('ignores empty / whitespace meta version values', () => {
    const result = deploymentReleaseLabel({
      ref: 'abcdef1234567890abcdef',
      meta: { releaseVersion: '   ' },
    });
    expect(result.version).toBeNull();
    expect(result.label).toBe('abcdef123456');
  });

  it('falls back to the id when there is no ref', () => {
    expect(deploymentReleaseLabel({ ref: '', id: 'dep-123', meta: null }).label).toBe('dep-123');
  });

  it('handles an empty deployment gracefully', () => {
    expect(deploymentReleaseLabel({ ref: '', meta: null }).label).toBe('-');
  });
});

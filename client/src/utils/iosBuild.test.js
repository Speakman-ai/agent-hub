/**
 * Tests for iOS build utility helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  IOS_BUILD_STATUS_CONFIG,
  buildArtifactGroups,
  formatBuildDuration,
  isBuildActive,
  getBuildStepDescription,
} from './iosBuild.js';

describe('IOS_BUILD_STATUS_CONFIG', () => {
  it('has entries for all known statuses', () => {
    const statuses = [
      'queued',
      'provisioning',
      'building',
      'archiving',
      'uploading',
      'ready',
      'error',
      'cancelled',
    ];
    for (const status of statuses) {
      expect(IOS_BUILD_STATUS_CONFIG[status]).toBeDefined();
      expect(IOS_BUILD_STATUS_CONFIG[status].label).toBeTruthy();
      expect(IOS_BUILD_STATUS_CONFIG[status].color).toBeTruthy();
    }
  });

  it('marks active statuses as animate: true', () => {
    expect(IOS_BUILD_STATUS_CONFIG.provisioning.animate).toBe(true);
    expect(IOS_BUILD_STATUS_CONFIG.building.animate).toBe(true);
    expect(IOS_BUILD_STATUS_CONFIG.archiving.animate).toBe(true);
    expect(IOS_BUILD_STATUS_CONFIG.uploading.animate).toBe(true);
  });

  it('marks terminal statuses as animate: false', () => {
    expect(IOS_BUILD_STATUS_CONFIG.ready.animate).toBe(false);
    expect(IOS_BUILD_STATUS_CONFIG.error.animate).toBe(false);
    expect(IOS_BUILD_STATUS_CONFIG.cancelled.animate).toBe(false);
    expect(IOS_BUILD_STATUS_CONFIG.queued.animate).toBe(false);
  });
});

describe('buildArtifactGroups', () => {
  it('separates artifacts by type', () => {
    const artifacts = [
      { id: '1', type: 'ipa', name: 'app.ipa' },
      { id: '2', type: 'simulator_recording', name: 'recording.mp4' },
      { id: '3', type: 'screenshot', name: 'home.png' },
      { id: '4', type: 'screenshot', name: 'settings.png' },
      { id: '5', type: 'log', name: 'build.log' },
    ];

    const groups = buildArtifactGroups(artifacts);

    expect(groups.ipas).toHaveLength(1);
    expect(groups.ipas[0].id).toBe('1');
    expect(groups.recordings).toHaveLength(1);
    expect(groups.recordings[0].id).toBe('2');
    expect(groups.screenshots).toHaveLength(2);
    expect(groups.logs).toHaveLength(1);
  });

  it('returns empty arrays for missing types', () => {
    const groups = buildArtifactGroups([]);
    expect(groups.ipas).toEqual([]);
    expect(groups.recordings).toEqual([]);
    expect(groups.screenshots).toEqual([]);
    expect(groups.logs).toEqual([]);
  });
});

describe('formatBuildDuration', () => {
  it('returns dash for null/undefined', () => {
    expect(formatBuildDuration(null)).toBe('—');
    expect(formatBuildDuration(undefined)).toBe('—');
  });

  it('formats seconds only', () => {
    expect(formatBuildDuration(45)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatBuildDuration(125)).toBe('2m 5s');
  });

  it('formats exact minutes without trailing seconds', () => {
    expect(formatBuildDuration(120)).toBe('2m');
  });

  it('formats hours and minutes', () => {
    expect(formatBuildDuration(3661)).toBe('1h 1m');
  });

  it('handles zero', () => {
    expect(formatBuildDuration(0)).toBe('0s');
  });
});

describe('isBuildActive', () => {
  it('returns true for active statuses', () => {
    expect(isBuildActive('queued')).toBe(true);
    expect(isBuildActive('provisioning')).toBe(true);
    expect(isBuildActive('building')).toBe(true);
    expect(isBuildActive('archiving')).toBe(true);
    expect(isBuildActive('uploading')).toBe(true);
  });

  it('returns false for terminal statuses', () => {
    expect(isBuildActive('ready')).toBe(false);
    expect(isBuildActive('error')).toBe(false);
    expect(isBuildActive('cancelled')).toBe(false);
  });

  it('returns false for unknown statuses', () => {
    expect(isBuildActive('unknown')).toBe(false);
  });
});

describe('getBuildStepDescription', () => {
  it('returns a description for each known status', () => {
    const statuses = [
      'queued',
      'provisioning',
      'building',
      'archiving',
      'uploading',
      'ready',
      'error',
      'cancelled',
    ];
    for (const status of statuses) {
      const desc = getBuildStepDescription(status);
      expect(desc).toBeTruthy();
      expect(typeof desc).toBe('string');
    }
  });

  it('returns fallback for unknown status', () => {
    expect(getBuildStepDescription('unknown')).toBe('Unknown status');
  });
});

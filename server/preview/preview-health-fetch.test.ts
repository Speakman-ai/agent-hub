import { describe, it, expect } from 'vitest';
import {
  filterComposeLogLinesForUi,
  healthCheckRequestInit,
  healthProbeHostHeader,
} from './preview-health-fetch.js';

describe('healthProbeHostHeader', () => {
  it('maps host.docker.internal to localhost', () => {
    expect(healthProbeHostHeader('host.docker.internal')).toBe('localhost');
  });

  it('returns undefined for loopback hostnames', () => {
    expect(healthProbeHostHeader('localhost')).toBeUndefined();
    expect(healthProbeHostHeader('127.0.0.1')).toBeUndefined();
  });
});

describe('healthCheckRequestInit', () => {
  it('sets Host localhost for host.docker.internal probes', () => {
    expect(healthCheckRequestInit('http://host.docker.internal:4100/')).toEqual({
      headers: { Host: 'localhost' },
    });
  });
});

describe('filterComposeLogLinesForUi', () => {
  it('drops postgres service lines from compose log tail', () => {
    const lines = [
      'backend-1  | ==> [preview] Postgres ready',
      'db-1       | 2026-05-22 LOG:  checkpoint starting: wal',
      'frontend-1 | Watch mode enabled.',
    ];
    expect(filterComposeLogLinesForUi(lines)).toEqual([
      'backend-1  | ==> [preview] Postgres ready',
      'frontend-1 | Watch mode enabled.',
    ]);
  });
});

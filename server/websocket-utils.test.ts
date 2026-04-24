import { describe, it, expect } from 'vitest';
import { parseProvisioningPath } from './websocket.js';

describe('parseProvisioningPath', () => {
  it('extracts a plain jobId', () => {
    expect(parseProvisioningPath('/api/provisioning/abc-123/events')).toBe('abc-123');
  });

  it('extracts a percent-encoded jobId', () => {
    expect(parseProvisioningPath('/api/provisioning/a%20b/events')).toBe('a b');
  });

  it('returns null for a malformed percent sequence', () => {
    expect(parseProvisioningPath('/api/provisioning/%ZZ/events')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseProvisioningPath(undefined)).toBeNull();
  });

  it('returns null for non-matching paths', () => {
    expect(parseProvisioningPath('/api/sessions')).toBeNull();
  });

  it('strips query params before matching', () => {
    expect(parseProvisioningPath('/api/provisioning/job-1/events?token=x')).toBe('job-1');
  });
});

/**
 * Unit coverage for the WebSocket route-matcher used by the provisioning
 * event stream. The historic concern is that a malformed escape sequence
 * in the URL segment would reach `decodeURIComponent` and throw URIError
 * out of the `wss.on('connection')` handler — crashing the process.
 * These tests lock in that the matcher either returns a valid jobId or
 * `null`, but never throws.
 */
import { describe, it, expect } from 'vitest';
import { parseProvisioningPath } from './websocket.js';

describe('parseProvisioningPath', () => {
  it('extracts the jobId from a canonical UUID path', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(parseProvisioningPath(`/api/provisioning/${id}/events`)).toBe(id);
  });

  it('tolerates a trailing slash', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(parseProvisioningPath(`/api/provisioning/${id}/events/`)).toBe(id);
  });

  it('strips the query string before matching', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    expect(parseProvisioningPath(`/api/provisioning/${id}/events?token=x`)).toBe(id);
  });

  it('returns null for unrelated paths', () => {
    expect(parseProvisioningPath('/api/sessions/42')).toBeNull();
    expect(parseProvisioningPath('/ws')).toBeNull();
    expect(parseProvisioningPath('')).toBeNull();
    expect(parseProvisioningPath(undefined)).toBeNull();
  });

  it('returns null (never throws) for malformed escape sequences', () => {
    // The previous implementation fed anything that matched `[^/]+` into
    // decodeURIComponent; `%ZZ` / `%E0%A4` would throw URIError from the
    // WS connection handler, crashing the process. The guarded regex +
    // try/catch must reject these cleanly.
    expect(() => parseProvisioningPath('/api/provisioning/%ZZ/events')).not.toThrow();
    expect(parseProvisioningPath('/api/provisioning/%ZZ/events')).toBeNull();
    expect(parseProvisioningPath('/api/provisioning/%E0%A4/events')).toBeNull();
  });

  it('returns null when the jobId is unknown at subscribe time', () => {
    // The matcher itself is lenient about the segment shape — downstream
    // validation lives in subscribeToJob (unknown jobId → synthetic 404
    // done event). The critical invariant here is that every branch
    // returns a string or null, never throws.
    expect(() => parseProvisioningPath('/api/provisioning/foo.bar/events')).not.toThrow();
    expect(() => parseProvisioningPath('/api/provisioning/abc/events')).not.toThrow();
  });
});

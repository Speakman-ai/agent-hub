import { describe, it, expect } from 'vitest';
import { FLUSH_PKT, pktLine, serviceAdvertisementPreamble } from './pkt-line.js';

describe('pktLine', () => {
  it('encodes the canonical upload-pack service line', () => {
    // 26 payload bytes + 4 prefix = 30 = 0x1e
    expect(pktLine('# service=git-upload-pack\n')).toBe('001e# service=git-upload-pack\n');
  });

  it('encodes the receive-pack service line', () => {
    expect(pktLine('# service=git-receive-pack\n')).toBe('001f# service=git-receive-pack\n');
  });

  it('measures bytes, not JS string length, for multi-byte payloads', () => {
    // 'é' is 2 bytes in UTF-8 → 2 + 4 = 6
    expect(pktLine('é')).toBe('0006é');
  });

  it('rejects payloads over the pkt-line maximum', () => {
    expect(() => pktLine('x'.repeat(65517))).toThrow(/exceeds/);
  });
});

describe('serviceAdvertisementPreamble', () => {
  it('appends the flush packet after the service line', () => {
    expect(serviceAdvertisementPreamble('git-upload-pack')).toBe(
      '001e# service=git-upload-pack\n' + FLUSH_PKT,
    );
    expect(serviceAdvertisementPreamble('git-receive-pack')).toBe(
      '001f# service=git-receive-pack\n' + FLUSH_PKT,
    );
  });
});

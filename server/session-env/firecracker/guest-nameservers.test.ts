import { describe, expect, it } from 'vitest';
import {
  FALLBACK_NAMESERVERS,
  parseResolvConfNameservers,
  resolveGuestNameservers,
} from './guest-nameservers.js';

describe('parseResolvConfNameservers', () => {
  it('reads nameserver lines in order and ignores everything else', () => {
    const contents = [
      '# Managed by something',
      'search example.internal',
      'nameserver 10.0.0.2',
      'options edns0 trust-ad',
      'nameserver 10.0.0.3',
      '; a comment',
    ].join('\n');
    expect(parseResolvConfNameservers(contents)).toEqual(['10.0.0.2', '10.0.0.3']);
  });

  it('drops loopback stubs, which point at the guest inside the guest', () => {
    const contents = 'nameserver 127.0.0.53\nnameserver ::1\nnameserver 10.0.0.2\n';
    expect(parseResolvConfNameservers(contents)).toEqual(['10.0.0.2']);
  });

  it('deduplicates repeated servers', () => {
    expect(parseResolvConfNameservers('nameserver 10.0.0.2\nnameserver 10.0.0.2\n')).toEqual([
      '10.0.0.2',
    ]);
  });

  it('returns nothing when only loopback stubs are configured', () => {
    expect(parseResolvConfNameservers('nameserver 127.0.0.53\n')).toEqual([]);
  });
});

describe('resolveGuestNameservers', () => {
  it('prefers the host resolvers, which are reachable from the NATed tap', async () => {
    const servers = await resolveGuestNameservers({
      readResolvConf: async () => 'nameserver 10.0.0.2\n',
    });
    expect(servers).toEqual(['10.0.0.2']);
  });

  it('caps the list at three', async () => {
    const servers = await resolveGuestNameservers({
      readResolvConf: async () =>
        ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'].map((s) => `nameserver ${s}`).join('\n'),
    });
    expect(servers).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  it('falls back to public resolvers when resolv.conf is unreadable', async () => {
    const servers = await resolveGuestNameservers({
      readResolvConf: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(servers).toEqual(FALLBACK_NAMESERVERS);
  });

  it('falls back when the host lists only loopback stubs', async () => {
    const servers = await resolveGuestNameservers({
      readResolvConf: async () => 'nameserver 127.0.0.53\n',
    });
    // Booting with no resolver at all looks like a dead network to everything
    // in the guest, so an imperfect answer beats an empty one.
    expect(servers).toEqual(FALLBACK_NAMESERVERS);
  });
});

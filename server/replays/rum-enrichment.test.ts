import { describe, it, expect, vi } from 'vitest';
import {
  parseUserAgent,
  normalizeIp,
  resolveGeoCountry,
  computeEnrichment,
  nullGeoResolver,
  type GeoResolver,
} from './rum-enrichment.js';

// Representative real-world UA strings, one per family we bucket.
const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeAndroidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

describe('parseUserAgent', () => {
  it('parses desktop Chrome on Windows', () => {
    expect(parseUserAgent(UA.chromeWin)).toEqual({
      deviceType: 'Desktop',
      browser: 'Chrome',
      os: 'Windows',
    });
  });

  it('parses Safari on macOS', () => {
    expect(parseUserAgent(UA.safariMac)).toEqual({
      deviceType: 'Desktop',
      browser: 'Safari',
      os: 'macOS',
    });
  });

  it('parses Firefox on Linux', () => {
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({
      deviceType: 'Desktop',
      browser: 'Firefox',
      os: 'Linux',
    });
  });

  it('detects Edge before Chrome (Edge UA embeds Chrome)', () => {
    expect(parseUserAgent(UA.edgeWin)).toMatchObject({ browser: 'Edge', os: 'Windows' });
  });

  it('parses mobile Safari on iOS as Mobile', () => {
    expect(parseUserAgent(UA.safariIphone)).toEqual({
      deviceType: 'Mobile',
      browser: 'Safari',
      os: 'iOS',
    });
  });

  it('detects iOS before macOS despite the "like Mac OS X" token', () => {
    expect(parseUserAgent(UA.safariIphone).os).toBe('iOS');
  });

  it('parses Chrome on an Android phone as Mobile (Android before Linux)', () => {
    expect(parseUserAgent(UA.chromeAndroidPhone)).toEqual({
      deviceType: 'Mobile',
      browser: 'Chrome',
      os: 'Android',
    });
  });

  it('classifies an Android UA without a Mobile token as a Tablet', () => {
    expect(parseUserAgent(UA.chromeAndroidTablet).deviceType).toBe('Tablet');
  });

  it('classifies iPad as a Tablet', () => {
    expect(parseUserAgent(UA.ipad).deviceType).toBe('Tablet');
  });

  it('maps CriOS (Chrome on iOS) to Chrome', () => {
    expect(parseUserAgent(UA.chromeIos)).toMatchObject({ browser: 'Chrome', os: 'iOS' });
  });

  it('detects Samsung Internet before Chrome', () => {
    expect(parseUserAgent(UA.samsung).browser).toBe('Samsung Internet');
  });

  it('classifies Googlebot as a Bot', () => {
    expect(parseUserAgent(UA.googlebot).deviceType).toBe('Bot');
  });

  it('returns all-null for missing / empty UA', () => {
    const empty = { deviceType: null, browser: null, os: null };
    expect(parseUserAgent(undefined)).toEqual(empty);
    expect(parseUserAgent(null)).toEqual(empty);
    expect(parseUserAgent('')).toEqual(empty);
    expect(parseUserAgent('   ')).toEqual(empty);
  });

  it('returns null browser/os for an unrecognized UA but still buckets device', () => {
    expect(parseUserAgent('SomeRandomAgent/1.0')).toEqual({
      deviceType: 'Desktop',
      browser: null,
      os: null,
    });
  });
});

describe('normalizeIp', () => {
  it('strips an IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('strips a trailing port from a bare IPv4', () => {
    expect(normalizeIp('203.0.113.5:54321')).toBe('203.0.113.5');
  });

  it('strips an IPv6 zone id', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('leaves a plain IPv6 untouched', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('returns empty for non-strings', () => {
    expect(normalizeIp(undefined)).toBe('');
    expect(normalizeIp(null)).toBe('');
  });
});

describe('resolveGeoCountry', () => {
  const usResolver: GeoResolver = () => 'us';

  it('resolves a public IP via the injected resolver and uppercases the code', () => {
    expect(resolveGeoCountry('203.0.113.5', usResolver)).toBe('US');
  });

  it('resolves an IPv4-mapped IPv6 public IP', () => {
    expect(resolveGeoCountry('::ffff:203.0.113.5', usResolver)).toBe('US');
  });

  it('returns null for private / loopback / link-local IPs without calling the resolver', () => {
    const resolver = vi.fn<GeoResolver>(() => 'US');
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.1.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(resolveGeoCountry(ip, resolver)).toBeNull();
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns null when the resolver yields nothing', () => {
    expect(resolveGeoCountry('203.0.113.5', () => null)).toBeNull();
  });

  it('rejects a malformed resolver return (wrong length / non-alpha)', () => {
    expect(resolveGeoCountry('203.0.113.5', () => 'USA')).toBeNull();
    expect(resolveGeoCountry('203.0.113.5', () => '1'.repeat(2))).toBeNull();
  });

  it('swallows a throwing resolver and returns null', () => {
    expect(
      resolveGeoCountry('203.0.113.5', () => {
        throw new Error('geo db down');
      }),
    ).toBeNull();
  });

  it('defaults to the null resolver (no geo db wired)', () => {
    expect(resolveGeoCountry('203.0.113.5')).toBeNull();
    expect(nullGeoResolver('203.0.113.5')).toBeNull();
  });
});

describe('computeEnrichment', () => {
  it('combines UA facets with a resolved geo country', () => {
    expect(
      computeEnrichment({
        userAgent: UA.chromeWin,
        ip: '203.0.113.5',
        geoResolver: () => 'de',
      }),
    ).toEqual({ deviceType: 'Desktop', browser: 'Chrome', os: 'Windows', geoCountry: 'DE' });
  });

  it('returns UA facets with null geo when no resolver is wired', () => {
    expect(computeEnrichment({ userAgent: UA.safariIphone, ip: '203.0.113.5' })).toEqual({
      deviceType: 'Mobile',
      browser: 'Safari',
      os: 'iOS',
      geoCountry: null,
    });
  });

  it('returns null when nothing can be derived (no UA, private IP)', () => {
    expect(
      computeEnrichment({ userAgent: '', ip: '127.0.0.1', geoResolver: () => 'US' }),
    ).toBeNull();
    expect(computeEnrichment({})).toBeNull();
  });

  it('returns geo-only enrichment when the UA is unparseable but the IP resolves', () => {
    expect(
      computeEnrichment({ userAgent: undefined, ip: '203.0.113.5', geoResolver: () => 'fr' }),
    ).toEqual({ deviceType: null, browser: null, os: null, geoCountry: 'FR' });
  });
});

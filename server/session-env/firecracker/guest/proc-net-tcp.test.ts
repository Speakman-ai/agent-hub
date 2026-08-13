import { describe, it, expect } from 'vitest';
import { parseListeningPorts, parseProcNetTcp } from './proc-net-tcp.js';

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

const tcp4 = [
  HEADER,
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1',
  '   1: 00000000:1068 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1',
  '   2: 0100007F:A0FA 6E1EA8C0:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1',
].join('\n');

const tcp6 = [
  HEADER,
  '   0: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 22222 1',
  '   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 22223 1',
].join('\n');

describe('parseProcNetTcp', () => {
  it('decodes the address little-endian within each word', () => {
    // Reading this big-endian turns 127.0.0.1 into 1.0.0.127, which looks
    // routable — the Hub would then advertise an upstream that only ever
    // answers from inside the guest.
    const [first] = parseProcNetTcp(tcp4);
    expect(first).toEqual({ port: 8080, address: '127.0.0.1', loopbackOnly: true });
  });

  it('reports a wildcard bind as reachable', () => {
    const listeners = parseProcNetTcp(tcp4);
    expect(listeners[1]).toEqual({ port: 4200, address: '0.0.0.0', loopbackOnly: false });
  });

  it('ignores sockets that are not in LISTEN state', () => {
    // State 01 is ESTABLISHED; counting it would advertise an ephemeral
    // client port as a dev server.
    expect(parseProcNetTcp(tcp4).map((l) => l.port)).toEqual([8080, 4200]);
  });

  it('decodes IPv6 wildcard and loopback', () => {
    const listeners = parseProcNetTcp(tcp6, 6);
    expect(listeners[0]).toEqual({ port: 8000, address: '::', loopbackOnly: false });
    expect(listeners[1].address).toBe('::1');
    expect(listeners[1].loopbackOnly).toBe(true);
  });

  it('tolerates empty and header-only input', () => {
    expect(parseProcNetTcp('')).toEqual([]);
    expect(parseProcNetTcp(HEADER)).toEqual([]);
  });

  it('skips malformed rows rather than throwing', () => {
    // /proc is read live; a torn read must not take down port discovery.
    const torn = `${HEADER}\n   0: 0100\n   1: :1F90 x 0A\n`;
    expect(parseProcNetTcp(torn)).toEqual([]);
  });
});

describe('parseListeningPorts', () => {
  it('merges both families and sorts by port', () => {
    expect(parseListeningPorts(tcp4, tcp6).map((l) => l.port)).toEqual([4200, 8000, 8080]);
  });

  it('prefers the reachable bind when a port appears in both families', () => {
    // Port 8080 is loopback-only on v4 here; if it were also wildcard on v6
    // the service does answer, and skipping it would break the preview.
    const wildcardV6 = [
      HEADER,
      '   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 1 1',
    ].join('\n');
    const merged = parseListeningPorts(tcp4, wildcardV6);
    const port8080 = merged.find((l) => l.port === 8080);
    expect(port8080?.loopbackOnly).toBe(false);
    expect(port8080?.address).toBe('::');
  });

  it('does not downgrade a reachable bind to a loopback one', () => {
    const loopbackV6 = [
      HEADER,
      '   0: 00000000000000000000000001000000:1068 00000000000000000000000000000000:0000 0A 0:0 00:0 0 1000 0 1 1',
    ].join('\n');
    const merged = parseListeningPorts(tcp4, loopbackV6);
    expect(merged.find((l) => l.port === 4200)?.loopbackOnly).toBe(false);
  });
});

/**
 * Parse listening TCP sockets out of `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * The guest has no docker daemon to ask "what ports are published", so port
 * discovery inside a microVM reads the kernel's own table. Pure and separated
 * from the agent so the parsing — the part that actually gets subtly wrong —
 * is testable off a Linux host.
 *
 * Format (one header line, then one row per socket):
 *
 *   sl  local_address rem_address   st tx_queue:rx_queue ...
 *    0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 ...
 *
 * `local_address` is `HEXADDR:HEXPORT`, and the address is little-endian
 * per 32-bit word — `0100007F` is 127.0.0.1, not 1.0.0.127. Reading it
 * big-endian is the classic bug here: it silently turns every loopback-only
 * bind into a routable-looking address, and the Hub would advertise a preview
 * upstream that refuses connections from outside the guest.
 */

export interface ProcNetListener {
  port: number;
  /** Dotted-quad (v4) or compressed hex groups (v6). */
  address: string;
  /** True when the socket is bound to a loopback address only. */
  loopbackOnly: boolean;
}

/** `st` column value for TCP_LISTEN. */
const TCP_LISTEN = '0A';

export function parseProcNetTcp(contents: string, family: 4 | 6 = 4): ProcNetListener[] {
  const listeners: ProcNetListener[] = [];
  const lines = contents.split('\n');
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[3].toUpperCase() !== TCP_LISTEN) continue;
    const [hexAddr, hexPort] = cols[1].split(':');
    if (!hexAddr || !hexPort) continue;
    const port = Number.parseInt(hexPort, 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    const address = family === 4 ? decodeIpv4(hexAddr) : decodeIpv6(hexAddr);
    if (address === null) continue;
    listeners.push({ port, address, loopbackOnly: isLoopbackAddress(address) });
  }
  return listeners;
}

/** Both families, de-duplicated by port with the widest bind winning. */
export function parseListeningPorts(tcp4: string, tcp6: string): ProcNetListener[] {
  const byPort = new Map<number, ProcNetListener>();
  for (const listener of [...parseProcNetTcp(tcp4, 4), ...parseProcNetTcp(tcp6, 6)]) {
    const existing = byPort.get(listener.port);
    // A service bound to both `127.0.0.1` and `::` is reachable; reporting
    // the loopback row would make the Hub skip a port that in fact answers.
    if (!existing || (existing.loopbackOnly && !listener.loopbackOnly)) {
      byPort.set(listener.port, listener);
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function decodeIpv4(hex: string): string | null {
  if (hex.length !== 8) return null;
  const value = Number.parseInt(hex, 16);
  if (!Number.isInteger(value)) return null;
  // Little-endian within the 32-bit word.
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff].join('.');
}

function decodeIpv6(hex: string): string | null {
  if (hex.length !== 32) return null;
  const words: string[] = [];
  // Four 32-bit words, each little-endian, then rendered as two 16-bit groups.
  for (let i = 0; i < 4; i++) {
    const word = hex.slice(i * 8, i * 8 + 8);
    const bytes = [word.slice(6, 8), word.slice(4, 6), word.slice(2, 4), word.slice(0, 2)];
    words.push(`${bytes[0]}${bytes[1]}`, `${bytes[2]}${bytes[3]}`);
  }
  const groups = words.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
  const joined = groups.join(':');
  if (/^(0:){7}0$/.test(joined)) return '::';
  if (/^(0:){6}0:1$/.test(joined)) return '::1';
  return joined;
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith('127.') || address === '::1';
}

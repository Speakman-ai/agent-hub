/**
 * Which resolvers to hand a guest microVM.
 *
 * The guest reaches the network through a NAT'd tap, so the host's own
 * resolvers are the ones known to work from that source address — on a cloud
 * host that includes a VPC resolver no public list would guess. Loopback
 * entries are the exception: `127.0.0.53` is systemd-resolved's local stub,
 * and inside the guest it resolves to the *guest's* loopback, where nothing
 * is listening.
 */
import { readFile } from 'fs/promises';

/** Used when the host has nothing usable to offer. */
export const FALLBACK_NAMESERVERS = ['1.1.1.1', '8.8.8.8'];

const RESOLV_CONF = '/etc/resolv.conf';
/** More than this and the guest resolver ignores the rest anyway. */
const MAX_NAMESERVERS = 3;

export function parseResolvConfNameservers(contents: string): string[] {
  const found: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^nameserver\s+(\S+)$/i.exec(line);
    if (!match) continue;
    const address = match[1];
    if (address === undefined || isLoopbackNameserver(address)) continue;
    if (!found.includes(address)) found.push(address);
  }
  return found;
}

function isLoopbackNameserver(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

export interface ResolveGuestNameserversDeps {
  readResolvConf?: () => Promise<string>;
}

/**
 * Never rejects and never returns empty: a guest booted with no resolver is
 * indistinguishable from a broken network to everything running inside it,
 * and that failure is far more expensive than using a public resolver.
 */
export async function resolveGuestNameservers(
  deps: ResolveGuestNameserversDeps = {},
): Promise<string[]> {
  const read = deps.readResolvConf ?? (() => readFile(RESOLV_CONF, 'utf8'));
  let hostServers: string[] = [];
  try {
    hostServers = parseResolvConfNameservers(await read());
  } catch {
    hostServers = [];
  }
  const chosen = hostServers.length > 0 ? hostServers : FALLBACK_NAMESERVERS;
  return chosen.slice(0, MAX_NAMESERVERS);
}

/**
 * Cross-listener ownership of HTTP `upgrade` events.
 *
 * Every `upgrade` listener on the Hub's HTTP server sees every upgrade. Most
 * route by URL path, but a host-routed tunnel (PR environments) can carry any
 * path, including one that looks like a Hub WebSocket route. The listener that
 * takes a socket claims the request first, and the others skip claimed
 * requests, so a socket is never handled twice.
 */
import type { IncomingMessage } from 'node:http';

const claimed = new WeakSet<IncomingMessage>();

export function claimUpgrade(req: IncomingMessage): void {
  claimed.add(req);
}

export function isUpgradeClaimed(req: IncomingMessage): boolean {
  return claimed.has(req);
}

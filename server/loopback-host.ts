/**
 * Is a hostname a loopback / local target?
 *
 * Two callers with opposite needs share this:
 *
 *   - The test network guard (`server/test/network-guard.ts`) lets loopback
 *     through and blocks everything else.
 *   - Preview dial-host resolution treats a loopback address as "no
 *     session-specific host", deferring to the Hub-wide default. That matters
 *     because a Hub running inside Docker cannot reach a dev server on *its
 *     own* loopback — it needs the docker-host gateway
 *     (`AGENT_HUB_PREVIEW_HEALTH_HOST`) instead. A session env that answers on
 *     its own address reports that address and is used verbatim.
 *
 * `0.0.0.0` counts as loopback here: as a *destination* it is not a routable
 * address for reaching another namespace, so the same "defer to the default"
 * treatment is correct.
 */

const LOOPBACK_LITERALS = new Set(['localhost', '0.0.0.0', '::1', '0:0:0:0:0:0:0:1', '']);

export function isLoopbackHost(hostname: string): boolean {
  // URL host for IPv6 arrives bracketed ("[::1]"); strip the brackets.
  const h = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (LOOPBACK_LITERALS.has(h)) return true;
  // Entire 127.0.0.0/8 block (the preview health tests use 127.0.0.2).
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

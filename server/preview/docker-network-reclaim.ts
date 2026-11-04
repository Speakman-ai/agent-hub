/**
 * Reclaim idle Docker networks when a preview boot hits address-pool
 * exhaustion ("could not find an available, non-overlapping IPv4 address
 * pool").
 *
 * The stock daemon config allows 31 user networks. On a shared Hub host,
 * agents create networks by hand (`docker network create st-foo-net`) while
 * testing a project and never remove them. Those carry no compose label, so
 * the Hub-owned compose reaper never sees them, and once the pool is full
 * every preview fails at `compose up`.
 *
 * This runs only after that failure, when the alternative is a preview that
 * cannot boot at all. It removes a network only when all of these hold:
 *   - docker lists it as dangling,
 *   - it is not a predefined network (bridge / host / none),
 *   - it is older than `minAgeMs`, so a network another session just created
 *     and is about to attach to is left alone,
 *   - no container references it by id or name, running, stopped, or created
 *     but never started (`dangling` alone is not enough: some daemon versions
 *     list networks with stopped members).
 * `docker network rm` also refuses a network with active endpoints, which
 * covers a container attaching between the check and the removal.
 *
 * Set `AGENT_HUB_PREVIEW_NETWORK_RECLAIM=0` to turn it off.
 */

import type { SysboxRunFn } from '../session-env/sysbox-session-env.js';

/** Networks younger than this are never reclaimed. */
export const DEFAULT_NETWORK_RECLAIM_MIN_AGE_MS = 60 * 60 * 1000;

const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none']);

export interface ReclaimIdleDockerNetworksOpts {
  run: SysboxRunFn;
  minAgeMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface ReclaimIdleDockerNetworksResult {
  removed: string[];
  errors: string[];
}

export function previewNetworkReclaimEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.AGENT_HUB_PREVIEW_NETWORK_RECLAIM?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Parse docker's `{{.CreatedAt}}` (`2026-10-21 17:43:36.421910969 +0000 UTC`)
 * to epoch ms, or null when it does not parse.
 */
export function parseDockerCreatedAt(raw: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-])(\d{2})(\d{2})/.exec(
    raw.trim(),
  );
  if (!m) return null;
  const [, date, time, frac, sign, hh, mm] = m;
  const ms = frac ? frac.slice(0, 3).padEnd(3, '0') : '000';
  const parsed = Date.parse(`${date}T${time}.${ms}${sign}${hh}:${mm}`);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function reclaimIdleDockerNetworks(
  opts: ReclaimIdleDockerNetworksOpts,
): Promise<ReclaimIdleDockerNetworksResult> {
  const result: ReclaimIdleDockerNetworksResult = { removed: [], errors: [] };
  const minAgeMs = opts.minAgeMs ?? DEFAULT_NETWORK_RECLAIM_MIN_AGE_MS;
  const now = (opts.now ?? Date.now)();
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;

  const listed = await opts.run([
    'docker',
    'network',
    'ls',
    '--filter',
    'dangling=true',
    '--format',
    '{{.ID}}\t{{.Name}}\t{{.CreatedAt}}',
  ]);
  if (!listed.ok) {
    result.errors.push(`list networks failed: ${listed.stderr.trim()}`);
    warn(`[network-reclaim] ${result.errors[0]}`);
    return result;
  }

  for (const line of listed.stdout.split('\n')) {
    const [id, name, createdAt] = line.trim().split('\t');
    if (!id || !name || PREDEFINED_NETWORKS.has(name)) continue;
    const created = parseDockerCreatedAt(createdAt ?? '');
    if (created === null || now - created < minAgeMs) continue;

    // Check the name as well as the id: a created-but-never-started container
    // holds the network by name only (its endpoint NetworkID is still empty),
    // so the id filter alone misses it.
    let referenced = false;
    let listFailed = false;
    for (const key of [id, name]) {
      const members = await opts.run(['docker', 'ps', '-aq', '--filter', `network=${key}`]);
      if (!members.ok) {
        result.errors.push(`list containers on ${name} failed: ${members.stderr.trim()}`);
        listFailed = true;
        break;
      }
      if (members.stdout.trim().length > 0) {
        referenced = true;
        break;
      }
    }
    if (listFailed || referenced) continue;

    const rm = await opts.run(['docker', 'network', 'rm', id]);
    if (rm.ok) result.removed.push(name);
    else result.errors.push(`rm network ${name} failed: ${rm.stderr.trim()}`);
  }

  if (result.removed.length > 0) {
    log(
      `[network-reclaim] removed ${result.removed.length} idle network(s): ${result.removed.join(', ')}`,
    );
  }
  for (const err of result.errors) warn(`[network-reclaim] ${err}`);
  return result;
}

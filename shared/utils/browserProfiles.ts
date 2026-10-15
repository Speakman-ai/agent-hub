/**
 * Pure helpers for the Settings → Browser Profiles pane, shared by web and
 * mobile so both group and label profiles the same way.
 */

export type BrowserDomainPolicy = 'allow' | 'ask' | 'block';

export interface BrowserDomainPolicyWire {
  domain: string;
  policy: BrowserDomainPolicy;
}

export const BROWSER_DOMAIN_POLICY_OPTIONS: ReadonlyArray<{
  value: BrowserDomainPolicy;
  label: string;
  description: string;
}> = [
  { value: 'allow', label: 'Allow', description: 'The agent acts freely.' },
  { value: 'ask', label: 'Ask first', description: 'Clicks and typing wait for your approval.' },
  { value: 'block', label: 'Block', description: 'The agent may not open or act on the site.' },
];

/**
 * Reduce what the user typed (`https://Shop.com/cart`, `shop.com`) to a bare
 * hostname, or null when it is not one. Mirrors the server's check so the
 * form can refuse input before a round trip.
 */
export function normalizePolicyDomainInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) {
    return null;
  }
  return host;
}

/** Shape of one row from `GET /api/me/browser-profiles`. */
export interface BrowserProfileWire {
  id: string;
  agentId: string;
  agentName: string;
  projectId: string;
  projectName: string;
  domains: string[];
  /** Site policies applied to agent browser ops; unlisted sites are allowed. */
  domainPolicies: BrowserDomainPolicyWire[];
  hasState: boolean;
  inUse: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserProfileAgentGroup {
  agentId: string;
  agentName: string;
  profiles: BrowserProfileWire[];
}

/** SQLite `datetime('now')` is UTC without a zone marker. */
export function parseSqliteUtc(value: string | null): Date | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLastUsed(value: string | null): string {
  const d = parseSqliteUtc(value);
  return d ? d.toLocaleString() : 'Never';
}

export function groupBrowserProfilesByAgent(
  profiles: BrowserProfileWire[],
): BrowserProfileAgentGroup[] {
  const groups = new Map<string, BrowserProfileAgentGroup>();
  for (const p of profiles) {
    let g = groups.get(p.agentId);
    if (!g) {
      g = { agentId: p.agentId, agentName: p.agentName, profiles: [] };
      groups.set(p.agentId, g);
    }
    g.profiles.push(p);
  }
  return [...groups.values()].sort((a, b) => a.agentName.localeCompare(b.agentName));
}

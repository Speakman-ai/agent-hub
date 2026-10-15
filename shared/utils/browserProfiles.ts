/**
 * Pure helpers for the Settings → Browser Profiles pane, shared by web and
 * mobile so both group and label profiles the same way.
 */

/** Shape of one row from `GET /api/me/browser-profiles`. */
export interface BrowserProfileWire {
  id: string;
  agentId: string;
  agentName: string;
  projectId: string;
  projectName: string;
  domains: string[];
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

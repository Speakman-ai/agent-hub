import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Trash2, X } from 'lucide-react';
import { api, type BrowserProfileWire } from '../utils/api';

/** SQLite `datetime('now')` is UTC without a zone marker. */
function parseSqliteUtc(value: string | null): Date | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLastUsed(value: string | null): string {
  const d = parseSqliteUtc(value);
  return d ? d.toLocaleString() : 'Never';
}

interface AgentGroup {
  agentId: string;
  agentName: string;
  profiles: BrowserProfileWire[];
}

function groupByAgent(profiles: BrowserProfileWire[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
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

export default function BrowserProfilesSection() {
  const [profiles, setProfiles] = useState<BrowserProfileWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getMyBrowserProfiles();
      setProfiles(res.profiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load browser profiles');
      setProfiles((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => groupByAgent(profiles ?? []), [profiles]);

  async function clearDomain(profile: BrowserProfileWire, domain: string) {
    if (
      !window.confirm(
        `Sign ${profile.agentName} out of ${domain}? Its cookies and site storage for that domain are removed.`,
      )
    ) {
      return;
    }
    setBusy(`${profile.id}:${domain}`);
    setError(null);
    try {
      const updated = await api.clearBrowserProfileDomain(profile.id, domain);
      setProfiles((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear domain');
    } finally {
      setBusy(null);
    }
  }

  async function deleteProfile(profile: BrowserProfileWire) {
    if (
      !window.confirm(
        `Delete ${profile.agentName}'s browser profile for ${profile.projectName}? Every saved sign-in is removed.`,
      )
    ) {
      return;
    }
    setBusy(profile.id);
    setError(null);
    try {
      await api.deleteBrowserProfile(profile.id);
      setProfiles((prev) => (prev ?? []).filter((p) => p.id !== profile.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="browser-profiles">
      <div>
        <h3 className="text-lg font-semibold">Browser Profiles</h3>
        <p className="text-sm text-gray-400">
          Sites your agents are signed into on your behalf. Only you can see these; clearing a
          domain signs the agent out of it.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {profiles === null && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading browser profiles…
        </div>
      )}

      {profiles !== null && profiles.length === 0 && !error && (
        <p className="text-sm text-gray-500" data-testid="browser-profiles-empty">
          No saved browser profiles yet. One is created the first time an agent signs into a site
          for you.
        </p>
      )}

      {groups.map((group) => (
        <section
          key={group.agentId}
          className="rounded-lg border border-gray-800 bg-gray-900/40"
          data-testid={`browser-profiles-agent-${group.agentId}`}
        >
          <header className="border-b border-gray-800 px-4 py-3">
            <h4 className="text-sm font-semibold text-gray-200">{group.agentName}</h4>
          </header>
          <ul className="divide-y divide-gray-800">
            {group.profiles.map((profile) => (
              <li
                key={profile.id}
                className="space-y-2 px-4 py-3"
                data-testid={`browser-profile-${profile.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-200">{profile.projectName}</div>
                    <div className="text-xs text-gray-500">
                      Last used {formatLastUsed(profile.lastUsedAt)}
                      {profile.inUse && (
                        <span className="ml-2 text-amber-400">In use by a running session</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteProfile(profile)}
                    disabled={busy !== null}
                    aria-label={`Delete browser profile for ${profile.agentName} in ${profile.projectName}`}
                    className="inline-flex items-center gap-1 rounded-md border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-50"
                  >
                    {busy === profile.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    Delete
                  </button>
                </div>
                {profile.domains.length === 0 ? (
                  <p className="text-xs text-gray-500">Not signed into any sites.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {profile.domains.map((domain) => (
                      <li
                        key={domain}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800 py-0.5 pl-2.5 pr-1 text-xs text-gray-300"
                      >
                        {domain}
                        <button
                          type="button"
                          onClick={() => clearDomain(profile, domain)}
                          disabled={busy !== null || profile.inUse}
                          title={
                            profile.inUse
                              ? 'Close the running session browser before clearing'
                              : `Clear ${domain}`
                          }
                          aria-label={`Clear ${domain} from ${profile.agentName}`}
                          className="rounded-full p-0.5 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-40"
                        >
                          {busy === `${profile.id}:${domain}` ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <X size={11} />
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import {
  BROWSER_DOMAIN_POLICY_OPTIONS,
  formatLastUsed,
  groupBrowserProfilesByAgent,
  normalizePolicyDomainInput,
  type BrowserDomainPolicy,
} from '@shared/utils/browserProfiles';
import { api, type BrowserProfileWire } from '../utils/api';

export { formatLastUsed };

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

  const groups = useMemo(() => groupBrowserProfilesByAgent(profiles ?? []), [profiles]);

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

  function replaceProfile(updated: BrowserProfileWire) {
    setProfiles((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
  }

  async function setPolicy(
    profile: BrowserProfileWire,
    domain: string,
    policy: BrowserDomainPolicy,
  ): Promise<boolean> {
    setBusy(`${profile.id}:policy:${domain}`);
    setError(null);
    try {
      replaceProfile(await api.setBrowserDomainPolicy(profile.id, domain, policy));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save site policy');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function removePolicy(profile: BrowserProfileWire, domain: string) {
    setBusy(`${profile.id}:policy:${domain}`);
    setError(null);
    try {
      replaceProfile(await api.deleteBrowserDomainPolicy(profile.id, domain));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove site policy');
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
                <SitePolicies
                  profile={profile}
                  busy={busy}
                  onSet={(domain, policy) => setPolicy(profile, domain, policy)}
                  onRemove={(domain) => removePolicy(profile, domain)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface SitePoliciesProps {
  profile: BrowserProfileWire;
  busy: string | null;
  onSet: (domain: string, policy: BrowserDomainPolicy) => Promise<boolean>;
  onRemove: (domain: string) => void;
}

/** Per-profile allow / ask / block list the host enforces on agent browser ops. */
function SitePolicies({ profile, busy, onSet, onRemove }: SitePoliciesProps) {
  const [draftDomain, setDraftDomain] = useState('');
  const [draftPolicy, setDraftPolicy] = useState<BrowserDomainPolicy>('ask');
  const [draftError, setDraftError] = useState<string | null>(null);
  const policies = profile.domainPolicies ?? [];

  async function add(e: FormEvent) {
    e.preventDefault();
    const domain = normalizePolicyDomainInput(draftDomain);
    if (!domain) {
      setDraftError('Enter a site such as example.com');
      return;
    }
    setDraftError(null);
    if (await onSet(domain, draftPolicy)) setDraftDomain('');
  }

  return (
    <div className="space-y-2 pt-1" data-testid={`browser-profile-policies-${profile.id}`}>
      <div className="text-xs font-medium text-gray-300">Site policies</div>
      <p className="text-xs text-gray-500">
        Ask first makes clicks and typing wait for your approval; Block stops the agent opening or
        acting on the site. A policy covers subdomains. Sites not listed are allowed.
      </p>
      {policies.length > 0 && (
        <ul className="space-y-1">
          {policies.map(({ domain, policy }) => {
            const rowBusy = busy === `${profile.id}:policy:${domain}`;
            return (
              <li key={domain} className="flex items-center gap-2 text-xs text-gray-300">
                <span className="min-w-0 flex-1 truncate">{domain}</span>
                <select
                  value={policy}
                  onChange={(e) => onSet(domain, e.target.value as BrowserDomainPolicy)}
                  disabled={busy !== null}
                  aria-label={`Policy for ${domain}`}
                  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
                >
                  {BROWSER_DOMAIN_POLICY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onRemove(domain)}
                  disabled={busy !== null}
                  aria-label={`Remove policy for ${domain}`}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-40"
                >
                  {rowBusy ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="flex items-center gap-2">
        <input
          value={draftDomain}
          onChange={(e) => setDraftDomain(e.target.value)}
          placeholder="example.com"
          aria-label={`New site policy domain for ${profile.agentName}`}
          className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-500"
        />
        <select
          value={draftPolicy}
          onChange={(e) => setDraftPolicy(e.target.value as BrowserDomainPolicy)}
          aria-label="New site policy"
          className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
        >
          {BROWSER_DOMAIN_POLICY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy !== null || !draftDomain.trim()}
          className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
        >
          <Plus size={12} /> Add
        </button>
      </form>
      {draftError && (
        <p role="alert" className="text-xs text-red-300">
          {draftError}
        </p>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  groupApprovalRules,
  ruleEffectLabel,
  type ApprovalRuleWire,
} from '@shared/utils/approvals';
import { api, type BrowserProfileWire } from '../utils/api';
import { formatPolicyDomain } from '@shared/utils/desktopAppPolicy';

/** Settings → Approvals: the rules "Always allow" saved, with delete. */
export default function ApprovalRulesSection() {
  const [rules, setRules] = useState<ApprovalRuleWire[] | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfileWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listApprovalRules();
      setRules(res.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approval rules');
      setRules((prev) => prev ?? []);
    }
    // Profile names only label the groups; rules still show without them.
    api
      .getMyBrowserProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupApprovalRules(rules ?? [], profiles), [rules, profiles]);

  async function remove(rule: ApprovalRuleWire) {
    if (
      !window.confirm(
        `Stop always allowing "${rule.action}" on ${formatPolicyDomain(rule.domain)}? The agent will ask you again next time.`,
      )
    ) {
      return;
    }
    setBusy(rule.id);
    setError(null);
    try {
      await api.deleteApprovalRule(rule.id);
      setRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete rule');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="approval-rules">
      <div>
        <h3 className="text-lg font-semibold">Approvals</h3>
        <p className="text-sm text-gray-400">
          Actions you told an agent it may always take on a site. Delete a rule and the agent asks
          you again before that action.
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

      {rules === null && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading approval rules…
        </div>
      )}

      {rules !== null && rules.length === 0 && !error && (
        <p className="text-sm text-gray-500" data-testid="approval-rules-empty">
          No remembered approvals. Choose Always allow when answering an approval to add one.
        </p>
      )}

      {groups.map((group) => (
        <section
          key={group.profileId}
          className="rounded-lg border border-gray-800 bg-gray-900/40"
          data-testid={`approval-rules-profile-${group.profileId}`}
        >
          <header className="border-b border-gray-800 px-4 py-3">
            <h4 className="text-sm font-semibold text-gray-200">{group.label}</h4>
          </header>
          <ul className="divide-y divide-gray-800">
            {group.rules.map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
                data-testid={`approval-rule-${rule.id}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-gray-200">
                    {rule.action} <span className="text-gray-500">on</span>{' '}
                    {formatPolicyDomain(rule.domain)}
                  </div>
                  <div className="text-xs text-gray-500">{ruleEffectLabel(rule.effect)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(rule)}
                  disabled={busy !== null}
                  aria-label={`Delete rule ${rule.action} on ${formatPolicyDomain(rule.domain)}`}
                  className="inline-flex items-center gap-1 rounded-md border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50 disabled:opacity-50"
                >
                  {busy === rule.id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { api, type QaEnvironmentWire } from '../utils/api';
import {
  draftFromQaEnvironment,
  emptyQaAccount,
  emptyQaEnvironment,
  parseQaAutoDelay,
  QA_AUTO_DELAY_MAX_MINUTES,
  QA_PASSWORD_MASK,
  qaEnvironmentDraftToInput,
  validateQaEnvironmentDraft,
  type QaAccountDraft,
  type QaEnvironmentDraft,
} from '@shared/utils/qaEnvironments';

const inputClass =
  'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function AccountRow({
  account,
  index,
  onChange,
  onRemove,
}: {
  account: QaAccountDraft;
  index: number;
  onChange: (patch: Partial<QaAccountDraft>) => void;
  onRemove: () => void;
}) {
  const savedPassword = account.password === QA_PASSWORD_MASK;
  return (
    <div
      className="grid grid-cols-1 gap-2 rounded-md border border-gray-800 p-2 md:grid-cols-[1fr_1.4fr_1.2fr_auto]"
      data-testid="qa-env-account"
    >
      <input
        className={inputClass}
        aria-label={`Account ${index + 1} label`}
        placeholder="Label (e.g. Admin)"
        value={account.label}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <input
        className={inputClass}
        aria-label={`Account ${index + 1} username`}
        placeholder="Username or email"
        autoComplete="off"
        value={account.username}
        onChange={(e) => onChange({ username: e.target.value })}
      />
      <input
        className={inputClass}
        type="password"
        aria-label={`Account ${index + 1} password`}
        placeholder="Password"
        autoComplete="new-password"
        value={account.password}
        title={savedPassword ? 'Saved. Type to replace it, or clear it to remove it.' : undefined}
        onFocus={(e) => savedPassword && e.target.select()}
        onChange={(e) => onChange({ password: e.target.value })}
      />
      <button
        type="button"
        aria-label={`Remove account ${index + 1}`}
        onClick={onRemove}
        className="self-center rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"
      >
        <Trash2 size={14} />
      </button>
      <input
        className={`${inputClass} md:col-span-3`}
        aria-label={`Account ${index + 1} notes`}
        placeholder="Notes (role, permissions, 2FA, what it can see)"
        value={account.notes}
        onChange={(e) => onChange({ notes: e.target.value })}
      />
    </div>
  );
}

function EnvironmentEditor({
  projectId,
  initial,
  onSaved,
  onDeleted,
  isDefault = false,
  onToggleDefault,
}: {
  projectId: string;
  initial: QaEnvironmentDraft;
  onSaved: (env: QaEnvironmentWire) => void;
  onDeleted: () => void;
  isDefault?: boolean;
  /** Absent for an unsaved environment: it has no id to mark yet. */
  onToggleDefault?: (next: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(!initial.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingDefault, setTogglingDefault] = useState(false);

  // Edits are locked while a save is in flight: the response replaces the
  // draft, so anything typed meanwhile would be silently dropped.
  const update = (patch: Partial<QaEnvironmentDraft>) => {
    if (saving) return;
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateAccount = (key: string, patch: Partial<QaAccountDraft>) =>
    update({ accounts: draft.accounts.map((a) => (a.key === key ? { ...a, ...patch } : a)) });

  const save = async () => {
    const invalid = validateQaEnvironmentDraft(draft);
    if (invalid) return setError(invalid);
    setSaving(true);
    setError(null);
    try {
      const input = qaEnvironmentDraftToInput(draft);
      const res = draft.id
        ? await api.updateQaEnvironment(projectId, draft.id, input)
        : await api.createQaEnvironment(projectId, input);
      setDraft(draftFromQaEnvironment(res.environment));
      setDirty(false);
      onSaved(res.environment);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft.id) return onDeleted();
    if (!window.confirm(`Delete environment "${draft.name}" and its test accounts?`)) return;
    try {
      await api.deleteQaEnvironment(projectId, draft.id);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/40 p-3"
      data-testid="qa-env-editor"
    >
      <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Name
            <input
              className={inputClass}
              placeholder="Staging"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Base URL
            <input
              className={inputClass}
              placeholder="https://staging.example.com"
              value={draft.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Server notes
          <textarea
            className={`${inputClass} min-h-[72px]`}
            placeholder="Build or version, seed data, feature flags, rate limits, anything a tester should know."
            value={draft.notes}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </label>
        <div className="flex flex-col gap-2">
          <div className="text-xs text-gray-400">Test accounts</div>
          {draft.accounts.map((a, i) => (
            <AccountRow
              key={a.key}
              account={a}
              index={i}
              onChange={(patch) => updateAccount(a.key, patch)}
              onRemove={() => update({ accounts: draft.accounts.filter((x) => x.key !== a.key) })}
            />
          ))}
          <button
            type="button"
            onClick={() => update({ accounts: [...draft.accounts, emptyQaAccount()] })}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            <Plus size={12} />
            Add account
          </button>
        </div>
        <label
          className="inline-flex w-fit items-center gap-2 text-xs text-gray-300"
          title={
            onToggleDefault
              ? 'Session "Run QA Tests" runs against the default environment'
              : 'Create the environment first'
          }
        >
          <input
            type="checkbox"
            data-testid="qa-env-default"
            checked={isDefault}
            disabled={!onToggleDefault || togglingDefault}
            onChange={async (e) => {
              if (!onToggleDefault) return;
              setTogglingDefault(true);
              setError(null);
              try {
                await onToggleDefault(e.target.checked);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setTogglingDefault(false);
              }
            }}
            className="h-3.5 w-3.5 accent-blue-500"
          />
          Default
        </label>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="qa-env-save"
            disabled={saving || !dirty}
            onClick={() => void save()}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : draft.id ? 'Save' : 'Create environment'}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            className="ml-auto rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-red-400"
          >
            {draft.id ? 'Delete environment' : 'Discard'}
          </button>
        </div>
      </fieldset>
    </section>
  );
}

function AutomatedQaSettings({ projectId }: { projectId: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getQaSettings(projectId)
      .then(({ settings }) => {
        if (cancelled) return;
        setSaved(settings.autoQaDelayMinutes);
        setValue(String(settings.autoQaDelayMinutes));
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const parsed = parseQaAutoDelay(value);
  const save = async () => {
    if (parsed === null) {
      setError(`Enter whole minutes from 0 to ${QA_AUTO_DELAY_MAX_MINUTES}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { settings } = await api.updateQaSettings(projectId, { autoQaDelayMinutes: parsed });
      setSaved(settings.autoQaDelayMinutes);
      setValue(String(settings.autoQaDelayMinutes));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-gray-800 bg-gray-900/40 p-3"
      data-testid="qa-automated-settings"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-gray-400">
          Default delay for automated QA (minutes)
          <input
            className={`${inputClass} w-32`}
            inputMode="numeric"
            aria-label="Default delay for automated QA"
            data-testid="qa-auto-delay"
            value={value}
            disabled={saved === null || saving}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <button
          type="button"
          data-testid="qa-auto-delay-save"
          disabled={saving || saved === null || parsed === saved}
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        When a session runs QA tests, the run waits this long after the session merges so the deploy
        can reach the default environment.
      </p>
      {error && <div className="mt-1 text-sm text-red-400">{error}</div>}
    </section>
  );
}

/**
 * QA settings: the servers QA plans test against and their test accounts.
 * Every QA run and authoring session gets these in its first message.
 */
export default function QaEnvironmentsSettings({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [saved, setSaved] = useState<QaEnvironmentWire[] | null>(null);
  const [drafts, setDrafts] = useState<Array<{ key: number; draft: QaEnvironmentDraft }>>([]);
  const [nextKey, setNextKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listQaEnvironments(projectId);
      setSaved(res.environments);
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setSaved([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto" data-testid="qa-settings">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to QA plans"
          className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-gray-100">QA settings</h1>
        <button
          type="button"
          data-testid="qa-env-add"
          onClick={() => {
            setDrafts((d) => [...d, { key: nextKey, draft: emptyQaEnvironment() }]);
            setNextKey((k) => k + 1);
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
        >
          <Plus size={12} />
          Add environment
        </button>
      </div>
      <p className="text-sm text-gray-400">
        Environments describe the servers QA tests run against and the accounts to log in with.
        Every QA run and plan-drafting session is given this list. Passwords are encrypted and are
        never shown to the QA agent: it types them through a placeholder.
      </p>
      <AutomatedQaSettings projectId={projectId} />
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {saved === null ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : saved.length === 0 && drafts.length === 0 ? (
        <div className="text-sm text-gray-500" data-testid="qa-env-empty">
          No environments yet.
        </div>
      ) : null}
      {(saved ?? []).map((env) => (
        <EnvironmentEditor
          key={env.id}
          projectId={projectId}
          initial={draftFromQaEnvironment(env)}
          isDefault={!!env.isDefault}
          onToggleDefault={async (next) => {
            await api.setQaEnvironmentDefault(projectId, env.id, next);
            setSaved((s) =>
              (s ?? []).map((x) => ({
                ...x,
                isDefault: x.id === env.id ? next : next ? false : x.isDefault,
              })),
            );
          }}
          onSaved={() => undefined}
          onDeleted={() => setSaved((s) => (s ?? []).filter((x) => x.id !== env.id))}
        />
      ))}
      {drafts.map(({ key, draft }) => (
        <EnvironmentEditor
          key={`new-${key}`}
          projectId={projectId}
          initial={draft}
          onSaved={(env) => {
            setDrafts((all) => all.filter((x) => x.key !== key));
            setSaved((s) => [...(s ?? []), env]);
          }}
          onDeleted={() => setDrafts((all) => all.filter((x) => x.key !== key))}
        />
      ))}
    </div>
  );
}

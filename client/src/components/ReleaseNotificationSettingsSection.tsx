import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, BellRing, Loader2, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api } from '../utils/api';

const FALLBACK_MAX_LENGTH = 4000;

interface ReleaseNotificationSettings {
  projectId: string;
  releaseDigestPrompt: string;
  defaultReleaseDigestPrompt: string;
  isDefault: boolean;
  promptMaxLength: number;
  factBoundedSystemTemplate: string;
  updatedBy: string | null;
  updatedAt: string | null;
  releaseDigestRecipients?: ReleaseDigestRecipient[];
}

interface ReleaseDigestRecipient {
  id: string;
  projectId: string;
  email: string;
  displayLabel: string | null;
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function ReleaseNotificationSettingsSection({
  projectId,
  showToast,
}: {
  projectId?: string | null;
  showToast?: (message: string, type?: string) => void;
}) {
  const [settings, setSettings] = useState<ReleaseNotificationSettings | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recipientSaving, setRecipientSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientLabel, setRecipientLabel] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setSettings(null);
      setValue('');
      return undefined;
    }
    setLoading(true);
    setError(null);
    api
      .getReleaseNotificationSettings(projectId)
      .then((res: ReleaseNotificationSettings) => {
        if (cancelled) return;
        setSettings(res);
        setValue(res?.releaseDigestPrompt || '');
        setRecipientEmail('');
        setRecipientLabel('');
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load release settings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const maxLength = settings?.promptMaxLength || FALLBACK_MAX_LENGTH;
  const trimmed = value.trim();
  const validationError = useMemo(() => {
    if (!trimmed) return 'Prompt is required.';
    if (trimmed.length > maxLength) return `Prompt must be ${maxLength} characters or fewer.`;
    return null;
  }, [maxLength, trimmed]);
  const dirty = settings ? value !== settings.releaseDigestPrompt : false;
  const recipients = settings?.releaseDigestRecipients;
  const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();
  const recipientValidationError = useMemo(() => {
    if (!recipientEmail.trim()) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail.trim())) {
      return 'Enter a valid recipient email.';
    }
    if (recipientLabel.trim().length > 120) {
      return 'Recipient label must be 120 characters or fewer.';
    }
    if (
      recipients?.some(
        (recipient) => recipient.email.trim().toLowerCase() === normalizedRecipientEmail,
      )
    ) {
      return 'This recipient is already on the list.';
    }
    return null;
  }, [normalizedRecipientEmail, recipientEmail, recipientLabel, recipients]);

  const handleSave = useCallback(async () => {
    if (!projectId || validationError || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateReleaseNotificationSettings(projectId, {
        releaseDigestPrompt: trimmed,
      });
      setSettings(res);
      setValue(res.releaseDigestPrompt);
      showToast?.('Release digest prompt saved', 'success');
    } catch (err: any) {
      setError(err?.message || 'Failed to save release settings.');
    } finally {
      setSaving(false);
    }
  }, [projectId, saving, showToast, trimmed, validationError]);

  const handleReset = useCallback(async () => {
    if (!projectId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.resetReleaseNotificationSettings(projectId);
      setSettings(res);
      setValue(res.releaseDigestPrompt);
      showToast?.('Release digest prompt reset', 'success');
    } catch (err: any) {
      setError(err?.message || 'Failed to reset release settings.');
    } finally {
      setSaving(false);
    }
  }, [projectId, saving, showToast]);

  const handleAddRecipient = useCallback(async () => {
    if (!projectId || recipientSaving || !recipientEmail.trim() || recipientValidationError) return;
    setRecipientSaving(true);
    setError(null);
    try {
      const recipient = await api.addReleaseDigestRecipient(projectId, {
        email: recipientEmail.trim(),
        displayLabel: recipientLabel.trim() || null,
      });
      setSettings((current) =>
        current
          ? {
              ...current,
              releaseDigestRecipients: [...(current.releaseDigestRecipients || []), recipient].sort(
                (a, b) => Number(b.enabled) - Number(a.enabled) || a.email.localeCompare(b.email),
              ),
            }
          : current,
      );
      setRecipientEmail('');
      setRecipientLabel('');
      showToast?.('Release digest recipient added', 'success');
    } catch (err: any) {
      setError(err?.message || 'Failed to add release digest recipient.');
    } finally {
      setRecipientSaving(false);
    }
  }, [
    projectId,
    recipientEmail,
    recipientLabel,
    recipientSaving,
    recipientValidationError,
    showToast,
  ]);

  const replaceRecipient = useCallback((recipient: ReleaseDigestRecipient) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            releaseDigestRecipients: (current.releaseDigestRecipients || []).map((item) =>
              item.id === recipient.id ? recipient : item,
            ),
          }
        : current,
    );
  }, []);

  const handleToggleRecipient = useCallback(
    async (recipient: ReleaseDigestRecipient) => {
      if (!projectId || recipientSaving) return;
      setRecipientSaving(true);
      setError(null);
      try {
        const updated = await api.updateReleaseDigestRecipient(projectId, recipient.id, {
          enabled: !recipient.enabled,
        });
        replaceRecipient(updated);
      } catch (err: any) {
        setError(err?.message || 'Failed to update release digest recipient.');
      } finally {
        setRecipientSaving(false);
      }
    },
    [projectId, recipientSaving, replaceRecipient],
  );

  const handleRemoveRecipient = useCallback(
    async (recipient: ReleaseDigestRecipient) => {
      if (!projectId || recipientSaving) return;
      setRecipientSaving(true);
      setError(null);
      try {
        await api.removeReleaseDigestRecipient(projectId, recipient.id);
        setSettings((current) =>
          current
            ? {
                ...current,
                releaseDigestRecipients: (current.releaseDigestRecipients || []).filter(
                  (item) => item.id !== recipient.id,
                ),
              }
            : current,
        );
        showToast?.('Release digest recipient removed', 'success');
      } catch (err: any) {
        setError(err?.message || 'Failed to remove release digest recipient.');
      } finally {
        setRecipientSaving(false);
      }
    },
    [projectId, recipientSaving, showToast],
  );

  if (loading && !settings) {
    return (
      <div className="bg-gray-800/30 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Loading release notification settings
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-gray-800/30 border border-gray-700 rounded-xl p-4"
      data-testid={`release-notification-settings-${projectId}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <BellRing size={16} className="text-sky-400" />
        <h4 className="text-sm font-semibold text-gray-200">Release digest prompt</h4>
        {(loading || saving) && <Loader2 size={14} className="animate-spin text-gray-400" />}
      </div>
      <p className="text-xs text-gray-500 mb-3 max-w-2xl">
        Guides the release digest tone and grouping. Generation stays limited to selected release
        items, linked cards, support-ticket summaries, and deployment metadata.
      </p>

      <textarea
        className="w-full min-h-40 bg-gray-950/70 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={maxLength + 1}
        disabled={saving || !projectId}
        aria-label="Release digest prompt"
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span
          className={`text-xs ${trimmed.length > maxLength ? 'text-red-300' : 'text-gray-500'}`}
        >
          {trimmed.length}/{maxLength}
          {settings?.isDefault ? ' · using default' : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving || loading || settings?.isDefault}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading || !dirty || !!validationError}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-600 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save size={13} />
            Save
          </button>
        </div>
      </div>

      {(error || validationError) && (
        <div className="mt-3 flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error || validationError}</span>
        </div>
      )}

      {recipients && (
        <div className="mt-5 border-t border-gray-700 pt-4">
          <div className="mb-3">
            <h4 className="text-sm font-semibold text-gray-200">Release digest recipients</h4>
            <p className="text-xs text-gray-500 mt-1">
              Admin-only list for production release digest emails. Disabled recipients remain saved
              but are skipped when digests are sent.
            </p>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_auto]">
            <input
              className="bg-gray-950/70 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.target.value)}
              disabled={recipientSaving}
              placeholder="recipient@example.com"
              aria-label="Release digest recipient email"
            />
            <input
              className="bg-gray-950/70 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
              value={recipientLabel}
              onChange={(event) => setRecipientLabel(event.target.value)}
              disabled={recipientSaving}
              placeholder="Optional label"
              aria-label="Release digest recipient label"
              maxLength={121}
            />
            <button
              type="button"
              onClick={handleAddRecipient}
              disabled={recipientSaving || !recipientEmail.trim() || !!recipientValidationError}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-sky-600 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {recipientSaving ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Plus size={13} />
              )}
              Add
            </button>
          </div>
          {recipientValidationError && (
            <p className="mt-2 text-xs text-red-300">{recipientValidationError}</p>
          )}

          <div className="mt-4 divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
            {recipients.length === 0 ? (
              <div className="px-3 py-3 text-xs text-gray-500">No release digest recipients.</div>
            ) : (
              recipients.map((recipient) => (
                <div
                  key={recipient.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 bg-gray-950/30"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-gray-200 break-all">{recipient.email}</span>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          recipient.enabled
                            ? 'text-emerald-200 border-emerald-500/30 bg-emerald-500/10'
                            : 'text-gray-400 border-gray-700 bg-gray-800/60'
                        }`}
                      >
                        {recipient.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    {recipient.displayLabel && (
                      <div className="text-xs text-gray-500 mt-0.5">{recipient.displayLabel}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggleRecipient(recipient)}
                      disabled={recipientSaving}
                      className="px-2.5 py-1.5 rounded-md border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                    >
                      {recipient.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveRecipient(recipient)}
                      disabled={recipientSaving}
                      className="inline-flex items-center justify-center p-1.5 rounded-md border border-gray-700 text-gray-400 hover:text-red-200 hover:border-red-500/40 disabled:opacity-50"
                      aria-label={`Remove ${recipient.email}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, BellRing, Loader2, RotateCcw, Save } from 'lucide-react';
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
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}

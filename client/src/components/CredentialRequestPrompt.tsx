import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api } from '../utils/api';
import type { CredentialRequestBlock } from '../utils/credentialRequests';
import {
  describeCredentialPersistOutcome,
  type CredentialPersistResult,
} from '@shared/utils/credentialPersistOutcome';

function statusLabel(status: string | null): string {
  if (status === 'submitted') return 'Credentials submitted';
  if (status === 'consumed') return 'Credentials used and discarded';
  if (status === 'expired') return 'Credentials expired';
  return 'Secure credential request';
}

export default function CredentialRequestPrompt({
  sessionId,
  request,
  submitted,
  onSubmit,
}: {
  sessionId: string;
  request: CredentialRequestBlock;
  submitted?: boolean;
  onSubmit?: (messageText: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.fields.map((field) => [field.key, ''])),
  );
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [remoteStatus, setRemoteStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .getSessionCredentialRequest(sessionId, request.requestId)
      .then((body: any) => {
        if (!cancelled) setRemoteStatus(body?.status || null);
      })
      .catch(() => {
        if (!cancelled) setRemoteStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, request.requestId]);

  const complete = submitted || remoteStatus === 'submitted' || remoteStatus === 'consumed';
  const expired = remoteStatus === 'expired';
  const canSubmit = useMemo(
    () => request.fields.every((field) => values[field.key]?.length > 0) && !complete && !expired,
    [request.fields, values, complete, expired],
  );

  async function handleSubmit() {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError('');
    try {
      const body = await api.submitSessionCredentialRequest(sessionId, request.requestId, {
        service: request.service,
        purpose: request.purpose,
        fields: request.fields,
        values,
        ttlSeconds: request.ttlSeconds,
        ...(request.persist ? { persist: request.persist } : {}),
      });
      setRemoteStatus(body?.status || 'submitted');
      setValues(Object.fromEntries(request.fields.map((field) => [field.key, ''])));
      const persisted = (body as { persisted?: CredentialPersistResult } | undefined)?.persisted;
      const persistedLine = describeCredentialPersistOutcome({
        service: request.service,
        persist: request.persist,
        persisted,
      }).line;
      onSubmit?.(
        [
          `${request.service} credentials were submitted securely for request \`${request.requestId}\`.`,
          '',
          persistedLine,
        ].join('\n'),
      );
    } catch (err: any) {
      setError(err?.message || 'Could not submit credentials.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-credential-request-id={request.requestId}
      className="border border-emerald-700/50 bg-emerald-950/20 rounded-lg overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-emerald-900/30 border-b border-emerald-700/40">
        <ShieldCheck size={15} className="text-emerald-300 shrink-0" />
        <span className="text-xs font-medium text-emerald-100">{statusLabel(remoteStatus)}</span>
      </div>
      <div className="p-3 space-y-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-100">
            <KeyRound size={15} className="text-emerald-300 shrink-0" />
            <span>{request.service}</span>
          </div>
          <p className="text-xs text-emerald-100/70 mt-1">{request.purpose}</p>
        </div>

        <div className="rounded-md border border-emerald-800/60 bg-black/20 px-3 py-2 text-xs text-emerald-100/75 flex items-start gap-2">
          <LockKeyhole size={14} className="text-emerald-300 shrink-0 mt-0.5" />
          <span>
            {request.persist
              ? `Values are sent to Agent Hub directly, skipped from chat history, and saved to your ${request.service} skill credentials for use in future sessions.`
              : 'Values are sent to Agent Hub directly, skipped from chat history, and discarded when they expire.'}
          </span>
        </div>

        <div className="space-y-2">
          {request.fields.map((field) => {
            const isHidden = field.type === 'password' && !visible[field.key];
            return (
              <label key={field.key} className="block">
                <span className="block text-xs text-emerald-100/80 mb-1">{field.label}</span>
                <span className="flex items-center gap-2">
                  <input
                    value={values[field.key] || ''}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                    }
                    type={isHidden ? 'password' : 'text'}
                    autoComplete={field.type === 'password' ? 'current-password' : 'username'}
                    disabled={complete || expired || saving}
                    className="min-w-0 flex-1 rounded-md border border-emerald-800/70 bg-gray-950/80 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                  />
                  {field.type === 'password' && (
                    <button
                      type="button"
                      onClick={() =>
                        setVisible((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                      }
                      disabled={complete || expired || saving}
                      className="w-9 h-9 inline-flex items-center justify-center rounded-md border border-emerald-800/70 text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50"
                      aria-label={visible[field.key] ? 'Hide password' : 'Show password'}
                    >
                      {visible[field.key] ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {error && (
          <div className="text-xs text-rose-200 bg-rose-950/40 border border-rose-700/50 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
              canSubmit && !saving
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
            }`}
          >
            {saving ? 'Submitting...' : complete ? 'Submitted' : expired ? 'Expired' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

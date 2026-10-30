import { useState } from 'react';
import { AlertCircle, Loader2, Send, Sparkles, X } from 'lucide-react';
import { api } from '../utils/api';

const BODY_MAX_LENGTH = 50_000;

/**
 * Regenerate a deployment's release digest, let the operator edit it, then
 * queue it to every enabled digest recipient as a new send.
 */
export default function ReleaseDigestResendPanel({
  projectId,
  deploymentId,
  onQueued,
  showToast,
}: {
  projectId: string;
  deploymentId: string;
  onQueued?: (releaseNotifications: any[]) => void;
  showToast?: (message: string, type?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await api.generateReleaseDigest(projectId, deploymentId);
      setBody(res.digestMarkdown || '');
      setSubject((current) => current || res.subject || '');
    } catch (err: any) {
      setError(err?.message || 'Failed to generate the release digest.');
    } finally {
      setGenerating(false);
    }
  };

  const start = () => {
    setOpen(true);
    if (!body) void generate();
  };

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const trimmedBody = body.trim();
  const bodyError = !trimmedBody
    ? 'Digest text is required.'
    : trimmedBody.length > BODY_MAX_LENGTH
      ? `Digest text must be ${BODY_MAX_LENGTH} characters or fewer.`
      : null;

  const send = async () => {
    if (bodyError || sending) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Send this digest to every enabled release digest recipient?')
    ) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.resendReleaseDigest(projectId, deploymentId, {
        digestMarkdown: trimmedBody,
        subject: subject.trim() || null,
      });
      onQueued?.(res.releaseNotifications || []);
      showToast?.(
        `Release digest queued for ${res.queued?.length ?? 0} recipient${
          res.queued?.length === 1 ? '' : 's'
        }`,
        'success',
      );
      setOpen(false);
      setBody('');
      setSubject('');
    } catch (err: any) {
      setError(err?.message || 'Failed to send the release digest.');
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        data-testid="release-digest-resend-open"
        className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800"
      >
        <Sparkles size={12} />
        Regenerate &amp; resend digest
      </button>
    );
  }

  return (
    <div
      className="rounded-md border border-sky-500/30 bg-gray-950/70 p-3"
      data-testid="release-digest-resend-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase text-gray-400">
          Regenerate &amp; resend digest
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Close digest editor"
          className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
        >
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-gray-500">
        Edit the generated digest before sending. It goes to every enabled recipient as a new send;
        earlier notifications stay in history.
      </p>
      <input
        className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-950/70 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
        disabled={sending}
        placeholder="Subject"
        aria-label="Release digest subject"
        maxLength={200}
      />
      {generating && !body ? (
        <div className="flex items-center gap-2 rounded-lg border border-gray-800 p-4 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Generating digest
        </div>
      ) : (
        <textarea
          className="min-h-64 w-full rounded-lg border border-gray-700 bg-gray-950/70 px-3 py-2 font-mono text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-sky-500"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={sending || generating}
          aria-label="Release digest body"
        />
      )}
      {error ? (
        <div className="mt-2 flex items-start gap-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs text-red-200">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={generating || sending}
          className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md border border-gray-700 px-2.5 text-xs text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          Regenerate
        </button>
        <button
          type="button"
          onClick={send}
          disabled={!!bodyError || generating || sending}
          className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md bg-sky-600 px-2.5 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send to recipients
        </button>
      </div>
    </div>
  );
}

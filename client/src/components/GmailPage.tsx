import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  ListPlus,
  Loader2,
  Mail,
  RefreshCw,
  Send,
  Ticket,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import { buildEmailTodoDraft } from '@shared/utils/captureTodo';
import { buildEmailCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import CaptureToTicketModal from './CaptureToTicketModal';
import {
  GMAIL_SURFACE_SCOPES,
  hasGmailReadScope,
  hasGmailSendScope,
  type GoogleStatusLike,
} from '../utils/googleSurface';

export { GMAIL_SURFACE_SCOPES };

type GoogleStatus = NonNullable<GoogleStatusLike>;

type GmailThreadSummary = {
  id: string | null;
  snippet: string | null;
  historyId: string | null;
};

type GmailMessage = {
  id: string | null;
  threadId: string | null;
  labelIds: string[];
  snippet: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
};

type ComposeFormState = {
  to: string;
  cc: string;
  subject: string;
  body: string;
};

/**
 * Split a comma/semicolon/whitespace-separated recipient string into a trimmed,
 * de-duplicated email list. Exported for unit testing the compose flow.
 */
export function parseRecipients(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (value || '').split(/[,;\s]+/)) {
    const email = raw.trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/**
 * Build the POST body for `/api/google/gmail/messages` from compose form state.
 * Exported for unit testing.
 */
export function buildSendBody(form: ComposeFormState) {
  const cc = parseRecipients(form.cc);
  return {
    to: parseRecipients(form.to),
    ...(cc.length ? { cc } : {}),
    subject: form.subject.trim() || undefined,
    text: form.body,
  };
}

function ComposeModal({
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: ComposeFormState) => void;
}) {
  const [form, setForm] = useState<ComposeFormState>({ to: '', cc: '', subject: '', body: '' });
  const setField = (field: keyof ComposeFormState, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const valid = parseRecipients(form.to).length > 0 && form.body.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">New message</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close compose"
          >
            <X size={16} />
          </button>
        </div>
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSubmit(form);
          }}
        >
          <label className="block">
            <span className="text-xs text-gray-400">To</span>
            <input
              value={form.to}
              onChange={(e) => setField('to', e.target.value)}
              placeholder="alice@example.com, bob@example.com"
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Cc</span>
            <input
              value={form.cc}
              onChange={(e) => setField('cc', e.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Subject</span>
            <input
              value={form.subject}
              onChange={(e) => setField('subject', e.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Message</span>
            <textarea
              value={form.body}
              onChange={(e) => setField('body', e.target.value)}
              rows={8}
              className="mt-1 w-full resize-none rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
          </label>
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || saving}
              className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ThreadModal({
  loading,
  error,
  subject,
  messages,
  capturing,
  captured,
  onCapture,
  onTicket,
  onClose,
}: {
  loading: boolean;
  error: string | null;
  subject: string;
  messages: GmailMessage[];
  capturing: boolean;
  captured: boolean;
  onCapture: () => void;
  onTicket: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
            {subject || '(no subject)'}
          </h3>
          <button
            type="button"
            onClick={onCapture}
            disabled={loading || capturing}
            title="Add to todos"
            className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            {capturing ? (
              <Loader2 size={13} className="animate-spin" />
            ) : captured ? (
              <Check size={13} className="text-emerald-400" />
            ) : (
              <ListPlus size={13} />
            )}
            {captured ? 'Added' : 'Add to todos'}
          </button>
          <button
            type="button"
            onClick={onTicket}
            disabled={loading}
            title="Create ticket"
            className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            <Ticket size={13} />
            Ticket
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close thread"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              Loading thread...
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message, index) => (
                <div
                  key={message.id || index}
                  className="rounded-lg border border-gray-800 bg-gray-950 p-3"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-gray-400">
                    <span className="truncate font-medium text-gray-200">
                      {message.from || '(unknown sender)'}
                    </span>
                    {message.date && <span className="flex-shrink-0">{message.date}</span>}
                  </div>
                  {message.to && (
                    <div className="mt-1 truncate text-xs text-gray-500">to {message.to}</div>
                  )}
                  <p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">
                    {message.bodyText || message.snippet || '(no content)'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GmailPage({
  onOpenAccountSettings,
}: {
  onOpenAccountSettings?: () => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [threads, setThreads] = useState<GmailThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [openThread, setOpenThread] = useState<{ id: string; subject: string } | null>(null);
  const [threadMessages, setThreadMessages] = useState<GmailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(false);
  // Direct-to-ticket capture: seeds the project/column picker (spec
  // CAPTURE-PROVENANCE); null when the picker is closed.
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setThreadsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasGmailReadScope(nextStatus)) {
        const body = await api.listGoogleGmailThreads({ maxResults: 25 });
        setThreads(body.threads || []);
      } else {
        setThreads([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Gmail');
      setThreads([]);
    } finally {
      setLoading(false);
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes: GMAIL_SURFACE_SCOPES });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  const openThreadDetail = async (thread: GmailThreadSummary) => {
    if (!thread.id) return;
    setOpenThread({ id: thread.id, subject: '' });
    setThreadMessages([]);
    setThreadError(null);
    setCaptured(false);
    setThreadLoading(true);
    try {
      const body = await api.getGoogleGmailThread(thread.id, { format: 'full' });
      const messages: GmailMessage[] = body.messages || [];
      const subject = messages.find((m) => m.subject)?.subject || '';
      setThreadMessages(messages);
      setOpenThread({ id: thread.id, subject });
    } catch (err: any) {
      setThreadError(err.message || 'Failed to load thread');
    } finally {
      setThreadLoading(false);
    }
  };

  const captureThread = async () => {
    if (!openThread) return;
    // Capture the selected thread: prefer the first message's headers (richer),
    // falling back to the thread id / modal subject.
    const first = threadMessages.find((m) => m.subject || m.from || m.snippet) || threadMessages[0];
    setCapturing(true);
    setError(null);
    try {
      await api.createTodo(
        buildEmailTodoDraft({
          threadId: openThread.id,
          messageId: first?.id ?? null,
          subject: first?.subject ?? openThread.subject,
          from: first?.from ?? null,
          snippet: first?.snippet ?? null,
        }),
      );
      setCaptured(true);
    } catch (err: any) {
      setError(err.message || 'Failed to add to todos');
    } finally {
      setCapturing(false);
    }
  };

  const captureThreadToTicket = () => {
    if (!openThread) return;
    // Same selected-thread resolution as the todo capture (richer first message
    // headers, falling back to the thread id / modal subject).
    const first = threadMessages.find((m) => m.subject || m.from || m.snippet) || threadMessages[0];
    setTicketDraft(
      buildEmailCardDraft({
        threadId: openThread.id,
        messageId: first?.id ?? null,
        subject: first?.subject ?? openThread.subject,
        from: first?.from ?? null,
        snippet: first?.snippet ?? null,
      }),
    );
  };

  const sendMessage = async (form: ComposeFormState) => {
    setSending(true);
    setComposeError(null);
    try {
      await api.sendGoogleGmailMessage(buildSendBody(form));
      setComposeOpen(false);
      await load();
    } catch (err: any) {
      setComposeError(err.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const gmailEnabled = hasGmailReadScope(status);
  const canSend = hasGmailSendScope(status);

  let emptyState: {
    title: string;
    body: string;
    action: string | null;
    onAction?: () => void;
  } | null = null;
  if (!configured && !connected) {
    emptyState = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Gmail can connect.',
      action: onOpenAccountSettings ? 'Open Account settings' : null,
      onAction: onOpenAccountSettings,
    };
  } else if (!connected) {
    emptyState = {
      title: 'Connect Google to use Gmail',
      body: 'Mail stays server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: startOAuth,
    };
  } else if (!gmailEnabled) {
    emptyState = {
      title: 'Enable Gmail access',
      body: `Connected as ${status?.email || 'Google account'}, but Gmail access has not been granted yet.`,
      action: 'Enable Gmail',
      onAction: startOAuth,
    };
  } else if (!threads.length && !threadsLoading) {
    emptyState = {
      title: 'No messages',
      body: 'Your recent threads will appear here. Compose a message or refresh after new mail arrives.',
      action: canSend ? 'Compose' : null,
      onAction: () => setComposeOpen(true),
    };
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-4 md:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-blue-300">
              <Mail size={14} />
              Gmail
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-white">Mail</h2>
            <p className="mt-1 text-sm text-gray-400">Recent threads from your Google account.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={load}
              disabled={threadsLoading}
              className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              <RefreshCw size={14} className={threadsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            {connected && canSend && (
              <button
                type="button"
                onClick={() => setComposeOpen(true)}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                <Send size={14} />
                Compose
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading Gmail...
          </div>
        ) : emptyState ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-lg font-semibold text-white">{emptyState.title}</h3>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">{emptyState.body}</p>
            {emptyState.action && (
              <button
                type="button"
                onClick={emptyState.onAction}
                disabled={oauthBusy}
                className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {oauthBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ExternalLink size={14} />
                )}
                {emptyState.action}
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
            {threads.map((thread) => (
              <button
                key={thread.id || thread.snippet}
                type="button"
                onClick={() => openThreadDetail(thread)}
                className="flex w-full items-start gap-3 border-b border-gray-800 p-4 text-left last:border-b-0 hover:bg-gray-800/50"
              >
                <Mail size={16} className="mt-0.5 flex-shrink-0 text-gray-500" />
                <p className="min-w-0 flex-1 truncate text-sm text-gray-200">
                  {thread.snippet || '(no preview)'}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
      {composeOpen && (
        <ComposeModal
          saving={sending}
          error={composeError}
          onCancel={() => setComposeOpen(false)}
          onSubmit={sendMessage}
        />
      )}
      {openThread && (
        <ThreadModal
          loading={threadLoading}
          error={threadError}
          subject={openThread.subject}
          messages={threadMessages}
          capturing={capturing}
          captured={captured}
          onCapture={captureThread}
          onTicket={captureThreadToTicket}
          onClose={() => setOpenThread(null)}
        />
      )}
      {ticketDraft && (
        <CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)} />
      )}
    </div>
  );
}

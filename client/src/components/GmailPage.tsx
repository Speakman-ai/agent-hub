import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  ListPlus,
  Loader2,
  Mail,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Ticket,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import type { SessionWire } from '@shared/types';
import { buildEmailTodoDraft, gmailThreadDeepLink } from '@shared/utils/captureTodo';
import { buildEmailSessionSeed } from '@shared/utils/sessionSeed';
import { buildEmailCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import CaptureToTicketModal from './CaptureToTicketModal';
import StartSessionModal from './StartSessionModal';
import GmailImportantSection from './GmailImportantSection';
import { withoutImportantThreads, type GmailImportantThread } from '@shared/utils/gmailImportance';
import {
  GMAIL_SURFACE_SCOPES,
  hasGmailReadScope,
  hasGmailSendScope,
  type GoogleStatusLike,
} from '../utils/googleSurface';
import {
  ALL_INBOXES,
  buildGmailReplyBody,
  defaultGoogleAccount,
  fetchAcrossGoogleAccounts,
  googleAccountColor,
  googleAccountParam,
  inboxAccounts,
  linkedGoogleAccounts,
  resolveInboxSelection,
  type AccountTagged,
  type GoogleStatusWithAccounts,
  type LinkedGoogleAccount,
} from '@shared/utils/googleAccounts';

export { GMAIL_SURFACE_SCOPES };

type GoogleStatus = NonNullable<GoogleStatusLike> & GoogleStatusWithAccounts;

type GmailThreadSummary = AccountTagged<{
  id: string | null;
  snippet: string | null;
  historyId: string | null;
}>;

type OpenThread = { id: string; subject: string; accountId: string; accountEmail: string };

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
  messageIdHeader?: string | null;
  replyTo?: string | null;
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
  accounts,
  initialAccountId,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  /** Accounts that can send; a picker appears when there are several. */
  accounts: LinkedGoogleAccount[];
  initialAccountId: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: ComposeFormState, accountId: string) => void;
}) {
  const [form, setForm] = useState<ComposeFormState>({ to: '', cc: '', subject: '', body: '' });
  const [accountId, setAccountId] = useState(initialAccountId);
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
            if (valid) onSubmit(form, accountId);
          }}
        >
          {accounts.length > 1 && (
            <label className="block">
              <span className="text-xs text-gray-400">From</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                aria-label="From"
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              >
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.email}
                  </option>
                ))}
              </select>
            </label>
          )}
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
  onStartSession,
  onClose,
  accountEmail,
  canReply,
  replying,
  replyError,
  onReply,
}: {
  loading: boolean;
  error: string | null;
  subject: string;
  messages: GmailMessage[];
  capturing: boolean;
  captured: boolean;
  onCapture: () => void;
  onTicket: () => void;
  onStartSession: () => void;
  onClose: () => void;
  /** The account that owns the thread; replies go out from it. */
  accountEmail?: string;
  canReply?: boolean;
  replying?: boolean;
  replyError?: string | null;
  onReply?: (text: string) => Promise<boolean>;
}) {
  const [reply, setReply] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={subject || '(no subject)'}
        className="flex max-h-full w-full flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
      >
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
            onClick={onStartSession}
            disabled={loading}
            title="Start session with this email as context"
            className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            <MessageSquarePlus size={13} />
            Start session
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
        {canReply && onReply && !loading && !error && messages.length > 0 && (
          <form
            className="border-t border-gray-800 p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              if (await onReply(reply)) setReply('');
            }}
          >
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              aria-label="Reply"
              placeholder={accountEmail ? `Reply as ${accountEmail}` : 'Reply'}
              className="w-full resize-none rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
            />
            {replyError && <div className="mt-2 text-xs text-red-300">{replyError}</div>}
            <div className="mt-2 flex justify-end">
              <button
                type="submit"
                disabled={!reply.trim() || replying}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {replying ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                Send reply
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function GmailPage({
  onOpenAccountSettings,
  onSessionStarted,
}: {
  onOpenAccountSettings?: () => void;
  onSessionStarted?: (session: SessionWire) => void;
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
  const [openThread, setOpenThread] = useState<OpenThread | null>(null);
  const [inbox, setInbox] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<GmailMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(false);
  // Async work for the thread modal (detail loads, replies, captures) must
  // only touch state while the conversation it started for is still open.
  // `conversationRef` changes when a different thread opens or the modal
  // closes; `detailRef` changes on every detail load, so only the newest load
  // of the open thread commits.
  const conversationRef = useRef(0);
  const detailRef = useRef(0);
  // The inbox in view right now, for async completions that reload it.
  const inboxRef = useRef<string | null>(null);
  // Changes whenever the compose window opens or closes, so a send that
  // finishes later can't close or show errors in a newer compose window.
  const composeRef = useRef(0);
  const setCompose = (open: boolean) => {
    composeRef.current += 1;
    setComposeError(null);
    setSending(false);
    setComposeOpen(open);
  };
  // Direct-to-ticket capture: seeds the project/column picker (spec
  // CAPTURE-PROVENANCE); null when the picker is closed.
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  // "Start session with this email as context": holds the pre-built seed and
  // display label while the project/agent picker is open; null when closed.
  const [sessionSeed, setSessionSeed] = useState<{ label: string; seed: string } | null>(null);
  // Threads the importance scan pinned above the list; hidden from the list below.
  const [pinned, setPinned] = useState<GmailImportantThread[]>([]);

  // Each load takes a ticket; only the latest may commit state, so a slow
  // response for an inbox the user already left can't overwrite the new one.
  const loadSeq = useRef(0);
  const load = useCallback(async (requested: string | null) => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    setError(null);
    setThreadsLoading(true);
    try {
      const nextStatus: GoogleStatus = await api.getGoogleStatus();
      if (!current()) return;
      setStatus(nextStatus);
      const accounts = linkedGoogleAccounts(nextStatus);
      const selection = resolveInboxSelection(requested, accounts, hasGmailReadScope);
      setInbox(selection);
      inboxRef.current = selection;
      const reading = inboxAccounts(selection, accounts, hasGmailReadScope).filter((a) =>
        hasGmailReadScope(a),
      );
      if (nextStatus.connected && reading.length) {
        const { items, failures } = await fetchAcrossGoogleAccounts<
          Omit<GmailThreadSummary, 'accountId' | 'accountEmail'>
        >(reading, async (account) => {
          const body = await api.listGoogleGmailThreads({
            maxResults: 25,
            account: googleAccountParam(account),
          });
          return body?.threads || [];
        });
        if (!current()) return;
        // Gmail's thread list carries no timestamp, so All inboxes groups by
        // account (each already newest first) rather than guessing an order.
        setThreads(items);
        if (failures.length) {
          setError(failures.map((f) => `${f.account.email}: ${f.error}`).join('; '));
        }
      } else {
        setThreads([]);
      }
    } catch (err: any) {
      if (!current()) return;
      setError(err.message || 'Failed to load Gmail');
      setThreads([]);
    } finally {
      if (current()) {
        setLoading(false);
        setThreadsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const accounts = useMemo(() => linkedGoogleAccounts(status), [status]);
  const readableAccounts = accounts.filter((a) => hasGmailReadScope(a));
  const sendAccounts = accounts.filter((a) => hasGmailSendScope(a));
  const defaultAccount = defaultGoogleAccount(accounts);
  const multiAccount = accounts.length > 1;
  const allInboxes = inbox === ALL_INBOXES;

  const selectInbox = (next: string) => {
    if (next === inbox) return;
    setInbox(next);
    inboxRef.current = next;
    setThreads([]);
    load(next);
  };

  const startOAuth = async (accountId?: string) => {
    setOauthBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({
        returnTo,
        scopes: GMAIL_SURFACE_SCOPES,
        ...(accountId ? { accountId } : {}),
      });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  const closeThread = () => {
    conversationRef.current += 1;
    setOpenThread(null);
  };

  /**
   * Open a thread, or (`refresh`) reload the one already open. Opening starts
   * a new conversation, which retires any reply, capture, or detail load still
   * in flight for the previous one.
   */
  const openThreadDetail = async (
    thread: { id: string | null; accountId?: string; accountEmail?: string },
    { refresh = false }: { refresh?: boolean } = {},
  ) => {
    if (!thread.id) return;
    if (!refresh) {
      conversationRef.current += 1;
      setReplying(false);
      setCapturing(false);
      setCaptured(false);
      setReplyError(null);
    }
    // A detail response commits only if it is the newest request AND its
    // conversation is still open: closing the modal or opening another thread
    // retires it, as does a later reload of the same thread.
    const request = ++detailRef.current;
    const conversation = conversationRef.current;
    const current = () => request === detailRef.current && conversation === conversationRef.current;
    const owner = {
      accountId: thread.accountId ?? '',
      accountEmail: thread.accountEmail ?? '',
    };
    if (!refresh) {
      setOpenThread({ id: thread.id, subject: '', ...owner });
      setThreadMessages([]);
    }
    setThreadError(null);
    setThreadLoading(true);
    try {
      const body = await api.getGoogleGmailThread(thread.id, {
        format: 'full',
        account: owner.accountId || undefined,
      });
      if (!current()) return;
      const messages: GmailMessage[] = body.messages || [];
      const subject = messages.find((m) => m.subject)?.subject || '';
      setThreadMessages(messages);
      setOpenThread({ id: thread.id, subject, ...owner });
    } catch (err: any) {
      if (current()) setThreadError(err.message || 'Failed to load thread');
    } finally {
      if (current()) setThreadLoading(false);
    }
  };

  const captureThread = async () => {
    if (!openThread) return;
    // Capture the selected thread: prefer the first message's headers (richer),
    // falling back to the thread id / modal subject.
    const first = threadMessages.find((m) => m.subject || m.from || m.snippet) || threadMessages[0];
    const conversation = conversationRef.current;
    const current = () => conversation === conversationRef.current;
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
      if (current()) setCaptured(true);
    } catch (err: any) {
      setError(err.message || 'Failed to add to todos');
    } finally {
      if (current()) setCapturing(false);
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

  const startSessionFromThread = () => {
    if (!openThread) return;
    const first = threadMessages.find((m) => m.subject || m.from || m.snippet) || threadMessages[0];
    const subject = first?.subject ?? openThread.subject;
    setSessionSeed({
      label: `Email: ${subject || '(no subject)'}`,
      seed: buildEmailSessionSeed({
        subject,
        from: first?.from ?? null,
        to: first?.to ?? null,
        snippet: first?.snippet ?? null,
        bodyText: first?.bodyText ?? null,
        deepLink: gmailThreadDeepLink(openThread.id),
      }),
    });
  };

  const sendMessage = async (form: ComposeFormState, accountId: string) => {
    const session = composeRef.current;
    const current = () => session === composeRef.current;
    setSending(true);
    setComposeError(null);
    try {
      await api.sendGoogleGmailMessage(buildSendBody(form), { account: accountId || undefined });
      // Sent either way; only close the compose window this send came from.
      if (current()) setCompose(false);
      await load(inboxRef.current);
    } catch (err: any) {
      if (current()) setComposeError(err.message || 'Failed to send message');
    } finally {
      if (current()) setSending(false);
    }
  };

  // A reply always leaves from the account that owns the thread.
  const threadOwner = openThread
    ? (accounts.find((a) => a.accountId === openThread.accountId) ?? null)
    : null;
  const canReply = !!threadOwner && hasGmailSendScope(threadOwner);

  const sendReply = async (text: string): Promise<boolean> => {
    if (!openThread || !threadOwner) return false;
    const body = buildGmailReplyBody({
      threadId: openThread.id,
      messages: threadMessages,
      accountEmail: threadOwner.email,
      text,
    });
    if (!body) {
      setReplyError('Could not find who to reply to in this thread.');
      return false;
    }
    const thread = openThread;
    const conversation = conversationRef.current;
    const current = () => conversation === conversationRef.current;
    setReplying(true);
    setReplyError(null);
    try {
      await api.sendGoogleGmailMessage(body, { account: googleAccountParam(threadOwner) });
      // The reply went out either way; only refresh the thread if it is still
      // the one on screen, so a finished send can't pull a closed thread back.
      if (!current()) return false;
      setReplying(false);
      await openThreadDetail(thread, { refresh: true });
      return current();
    } catch (err: any) {
      if (current()) setReplyError(err.message || 'Failed to send reply');
      return false;
    } finally {
      if (current()) setReplying(false);
    }
  };

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const gmailEnabled = readableAccounts.length > 0;
  const canSend = sendAccounts.length > 0;
  // The importance scan reads the default account, so its pinned threads only
  // belong in views that include that inbox.
  const showImportant =
    !!defaultAccount &&
    hasGmailReadScope(defaultAccount) &&
    (allInboxes || inbox === defaultAccount.accountId);
  const listThreads = withoutImportantThreads(threads, showImportant ? pinned : []);
  const composeAccountId =
    sendAccounts.find((a) => a.accountId === inbox)?.accountId ??
    (defaultAccount && hasGmailSendScope(defaultAccount)
      ? defaultAccount.accountId
      : (sendAccounts[0]?.accountId ?? ''));
  const accountsMissingGmail = accounts.filter((a) => !hasGmailReadScope(a));

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
      onAction: () => startOAuth(),
    };
  } else if (!gmailEnabled) {
    emptyState = {
      title: 'Enable Gmail access',
      body: `Connected as ${status?.email || 'Google account'}, but Gmail access has not been granted yet.`,
      action: 'Enable Gmail',
      onAction: () => startOAuth(defaultAccount?.accountId || undefined),
    };
  } else if (!threads.length && !threadsLoading) {
    emptyState = {
      title: 'No messages',
      body: 'Your recent threads will appear here. Compose a message or refresh after new mail arrives.',
      action: canSend ? 'Compose' : null,
      onAction: () => setCompose(true),
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
            <p className="mt-1 text-sm text-gray-400">
              {allInboxes
                ? 'Recent threads from every linked Google account.'
                : 'Recent threads from your Google account.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => load(inbox)}
              disabled={threadsLoading}
              className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
            >
              <RefreshCw size={14} className={threadsLoading ? 'animate-spin' : ''} />
              Refresh
            </button>
            {connected && canSend && (
              <button
                type="button"
                onClick={() => setCompose(true)}
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

        {!loading && connected && multiAccount && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {readableAccounts.length > 0 && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-400">
                Inbox
                <select
                  value={inbox ?? ''}
                  onChange={(e) => selectInbox(e.target.value)}
                  aria-label="Inbox"
                  className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
                >
                  {readableAccounts.length > 1 && <option value={ALL_INBOXES}>All inboxes</option>}
                  {readableAccounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {accountsMissingGmail.map((a) => (
              <button
                key={a.accountId}
                type="button"
                onClick={() => startOAuth(a.accountId)}
                disabled={oauthBusy}
                className="rounded-full border border-gray-700 px-3 py-1 text-xs text-blue-300 hover:bg-gray-800 disabled:opacity-50"
              >
                Enable Gmail for {a.email}
              </button>
            ))}
          </div>
        )}

        {!loading && connected && showImportant && (
          <GmailImportantSection
            onOpenThread={(id) =>
              openThreadDetail({
                id,
                accountId: defaultAccount?.accountId ?? '',
                accountEmail: defaultAccount?.email ?? '',
              })
            }
            onPinnedChange={setPinned}
          />
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
        ) : listThreads.length === 0 ? null : (
          <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
            {listThreads.map((thread) => (
              <button
                key={`${thread.accountId}:${thread.id || thread.snippet}`}
                type="button"
                onClick={() => openThreadDetail(thread)}
                className="flex w-full items-start gap-3 border-b border-gray-800 p-4 text-left last:border-b-0 hover:bg-gray-800/50"
              >
                <Mail
                  size={16}
                  className="mt-0.5 flex-shrink-0 text-gray-500"
                  style={
                    allInboxes
                      ? { color: googleAccountColor(accounts, thread.accountId) }
                      : undefined
                  }
                />
                <p className="min-w-0 flex-1 truncate text-sm text-gray-200">
                  {thread.snippet || '(no preview)'}
                </p>
                {allInboxes && (
                  <span className="flex-shrink-0 text-xs text-gray-500">{thread.accountEmail}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {composeOpen && (
        <ComposeModal
          accounts={sendAccounts}
          initialAccountId={composeAccountId}
          saving={sending}
          error={composeError}
          onCancel={() => setCompose(false)}
          onSubmit={sendMessage}
        />
      )}
      {openThread && (
        <ThreadModal
          // One instance per conversation, so a reply draft never carries
          // over to another thread.
          key={`${openThread.accountId}:${openThread.id}`}
          loading={threadLoading}
          error={threadError}
          subject={openThread.subject}
          messages={threadMessages}
          capturing={capturing}
          captured={captured}
          onCapture={captureThread}
          onTicket={captureThreadToTicket}
          onStartSession={startSessionFromThread}
          onClose={closeThread}
          accountEmail={threadOwner?.email}
          canReply={canReply}
          replying={replying}
          replyError={replyError}
          onReply={sendReply}
        />
      )}
      {ticketDraft && (
        <CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)} />
      )}
      {sessionSeed && (
        <StartSessionModal
          contextLabel={sessionSeed.label}
          seedMessage={sessionSeed.seed}
          defaultName={sessionSeed.label}
          onClose={() => setSessionSeed(null)}
          onStarted={(session) => onSessionStarted?.(session)}
        />
      )}
    </div>
  );
}

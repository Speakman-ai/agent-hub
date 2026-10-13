import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  ExternalLink,
  Eye,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import PdfPages from './PdfPages';
import {
  attachmentViewKind,
  isPreviewableImage,
  viewerMimeType,
  type AttachmentViewKind,
  type ChatAttachment,
} from '../utils/googleChat';

type Props = {
  spaceId: string;
  messageId: string;
  attachments: ChatAttachment[];
};

type AttachmentRef = { spaceId: string; messageId: string; attachment: ChatAttachment };

/** Text past this size is cut off in the viewer; the download has it all. */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

const FOCUSABLE =
  'button:not([disabled]), [href], video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

function label(attachment: ChatAttachment): string {
  return attachment.contentName || 'Attachment';
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function KindIcon({ kind }: { kind: AttachmentViewKind | null }) {
  const Icon =
    kind === 'video' ? Film : kind === 'audio' ? Music : kind === 'image' ? ImageIcon : FileText;
  return <Icon size={12} className="shrink-0" />;
}

function AttachmentViewer({
  spaceId,
  messageId,
  attachment,
  kind,
  initialBlob,
  onClose,
}: AttachmentRef & {
  kind: AttachmentViewKind;
  initialBlob?: Blob | null;
  onClose: () => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(initialBlob ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (blob) return;
    let cancelled = false;
    api
      .fetchGoogleChatAttachment(spaceId, messageId, attachment.id)
      .then((b) => {
        if (!cancelled) setBlob(b);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [blob, spaceId, messageId, attachment.id]);

  const mime = viewerMimeType(attachment, kind);
  useEffect(() => {
    if (!blob) return;
    if (kind === 'text') {
      let cancelled = false;
      setTruncated(blob.size > TEXT_PREVIEW_LIMIT);
      blob
        .slice(0, TEXT_PREVIEW_LIMIT)
        .text()
        .then((t) => {
          if (!cancelled) setText(t);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }
    if (kind === 'pdf') return;
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob, kind, mime]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Modal focus contract: focus moves in on open, Tab cycles inside, the rest
  // of the page is inert, and focus returns to the trigger on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === dialog || el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      inerted.push(el);
    }
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !active || !dialog.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const el of inerted) el.removeAttribute('inert');
      if (trigger && trigger.isConnected) trigger.focus();
    };
  }, []);

  const ready = kind === 'text' ? text !== null : kind === 'pdf' ? blob !== null : url !== null;
  let body: ReactNode;
  if (error) {
    body = (
      <p className="p-6 text-sm text-red-300">
        Could not load {label(attachment)}: {error}
      </p>
    );
  } else if (!ready) {
    body = (
      <div className="flex h-48 w-72 items-center justify-center text-gray-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  } else if (kind === 'image') {
    body = (
      <img
        src={url!}
        alt={label(attachment)}
        className="max-h-[80vh] max-w-[90vw] object-contain"
      />
    );
  } else if (kind === 'pdf') {
    body = <PdfPages data={blob!} title={label(attachment)} />;
  } else if (kind === 'video') {
    body = (
      <video src={url!} controls autoPlay className="max-h-[80vh] max-w-[90vw]">
        <track kind="captions" />
      </video>
    );
  } else if (kind === 'audio') {
    body = (
      <div className="p-6">
        <audio src={url!} controls autoPlay className="w-80 max-w-[80vw]" />
      </div>
    );
  } else {
    body = (
      <div className="max-h-[80vh] w-[min(90vw,1000px)] overflow-auto">
        <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-gray-200">
          {text}
        </pre>
        {truncated && (
          <p className="border-t border-gray-800 px-4 py-2 text-xs text-gray-400">
            Showing the first {TEXT_PREVIEW_LIMIT / 1024} KB. Download for the full file.
          </p>
        )}
      </div>
    );
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label(attachment)}
      data-testid="chat-attachment-viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full max-w-full flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2 text-sm text-gray-200">
          <span className="min-w-0 flex-1 truncate" title={label(attachment)}>
            {label(attachment)}
          </span>
          <button
            type="button"
            disabled={!blob}
            onClick={() => blob && saveBlob(blob, label(attachment))}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            <Download size={12} /> Download
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex min-h-0 items-center justify-center">{body}</div>
      </div>
    </div>,
    document.body,
  );
}

function ImagePreview({ spaceId, messageId, attachment }: AttachmentRef) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .fetchGoogleChatAttachment(spaceId, messageId, attachment.id)
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [spaceId, messageId, attachment.id]);

  if (failed) {
    return <FileChip spaceId={spaceId} messageId={messageId} attachment={attachment} />;
  }
  if (!url) {
    return (
      <div
        data-testid="chat-attachment-loading"
        className="flex h-24 w-32 items-center justify-center rounded-lg bg-gray-900/60 text-gray-500"
      >
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${label(attachment)}`}
        className="cursor-zoom-in rounded-lg"
      >
        <img
          src={url}
          alt={label(attachment)}
          className="max-h-64 max-w-full rounded-lg border border-gray-700 object-contain hover:brightness-110"
        />
      </button>
      {open && (
        <AttachmentViewer
          spaceId={spaceId}
          messageId={messageId}
          attachment={attachment}
          kind="image"
          initialBlob={blob}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FileChip({ spaceId, messageId, attachment }: AttachmentRef) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const kind = attachmentViewKind(attachment);
  const chipClass =
    'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900/60 px-2 py-1 text-xs text-gray-200 hover:bg-gray-900';

  if (attachment.driveUrl) {
    return (
      <a href={attachment.driveUrl} target="_blank" rel="noreferrer" className={chipClass}>
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label(attachment)}</span>
        <ExternalLink size={12} className="shrink-0 text-gray-400" />
      </a>
    );
  }
  if (!attachment.downloadable) {
    return (
      <span className={chipClass}>
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label(attachment)}</span>
      </span>
    );
  }

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.fetchGoogleChatAttachment(spaceId, messageId, attachment.id);
      saveBlob(blob, label(attachment));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadIcon = busy ? (
    <Loader2 size={12} className="shrink-0 animate-spin" />
  ) : (
    <Download size={12} className="shrink-0 text-gray-400" />
  );

  if (!kind) {
    return (
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        title={error ?? `Download ${label(attachment)}`}
        className={`${chipClass} ${error ? 'border-red-700 text-red-300' : ''}`}
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label(attachment)}</span>
        {downloadIcon}
      </button>
    );
  }

  return (
    <span
      className={`inline-flex max-w-full items-stretch overflow-hidden rounded-lg border bg-gray-900/60 text-xs text-gray-200 ${
        error ? 'border-red-700 text-red-300' : 'border-gray-700'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${label(attachment)}`}
        className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 hover:bg-gray-900"
      >
        <KindIcon kind={kind} />
        <span className="truncate">{label(attachment)}</span>
        <Eye size={12} className="shrink-0 text-gray-400" />
      </button>
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        aria-label={`Download ${label(attachment)}`}
        title={error ?? `Download ${label(attachment)}`}
        className="inline-flex items-center border-l border-gray-700 px-1.5 hover:bg-gray-900"
      >
        {downloadIcon}
      </button>
      {open && (
        <AttachmentViewer
          spaceId={spaceId}
          messageId={messageId}
          attachment={attachment}
          kind={kind}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

export default function GoogleChatAttachments({ spaceId, messageId, attachments }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div data-testid="chat-attachments" className="mt-2 flex flex-col items-start gap-1.5">
      {attachments.map((attachment) =>
        isPreviewableImage(attachment) ? (
          <ImagePreview
            key={attachment.id}
            spaceId={spaceId}
            messageId={messageId}
            attachment={attachment}
          />
        ) : (
          <FileChip
            key={attachment.id}
            spaceId={spaceId}
            messageId={messageId}
            attachment={attachment}
          />
        ),
      )}
    </div>
  );
}

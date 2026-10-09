import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { api } from '../utils/api';
import { isPreviewableImage, type ChatAttachment } from '../utils/googleChat';

type Props = {
  spaceId: string;
  messageId: string;
  attachments: ChatAttachment[];
};

function label(attachment: ChatAttachment): string {
  return attachment.contentName || 'Attachment';
}

function ImagePreview({
  spaceId,
  messageId,
  attachment,
}: {
  spaceId: string;
  messageId: string;
  attachment: ChatAttachment;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .fetchGoogleChatAttachment(spaceId, messageId, attachment.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
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
    <a href={url} target="_blank" rel="noreferrer" title={label(attachment)}>
      <img
        src={url}
        alt={label(attachment)}
        className="max-h-64 max-w-full rounded-lg border border-gray-700 object-contain"
      />
    </a>
  );
}

function FileChip({
  spaceId,
  messageId,
  attachment,
}: {
  spaceId: string;
  messageId: string;
  attachment: ChatAttachment;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = label(attachment);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
      {busy ? (
        <Loader2 size={12} className="shrink-0 animate-spin" />
      ) : (
        <Download size={12} className="shrink-0 text-gray-400" />
      )}
    </button>
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

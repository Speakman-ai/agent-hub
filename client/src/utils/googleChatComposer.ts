import type { GoogleChatAttachmentDataRef } from './api';

/** Mirrors the server's upload cap (Google allows more; the proxy buffers). */
export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 10;

export type PendingChatAttachment = {
  /** Local id; the upload reference only exists once the upload finishes. */
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  ref?: GoogleChatAttachmentDataRef;
  error?: string;
};

/** Why a picked file can't be uploaded, or null when it can. */
export function attachmentRejection(file: { size: number }): string | null {
  if (file.size === 0) return 'File is empty';
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) return 'File is larger than 25 MB';
  return null;
}

/** Room left for new files, given what is already attached. */
export function attachmentSlotsLeft(attachments: PendingChatAttachment[]): number {
  return Math.max(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE - attachments.length);
}

export function hasFailedAttachments(attachments: PendingChatAttachment[]): boolean {
  return attachments.some((a) => a.status === 'error');
}

/**
 * A message can go out once it has text or at least one finished upload, and
 * every file is ready. Sending with a file still uploading or failed would
 * clear its chip without sending it, so the user has to remove it first.
 */
export function canSendComposer(text: string, attachments: PendingChatAttachment[]): boolean {
  if (attachments.some((a) => a.status !== 'ready')) return false;
  return text.trim().length > 0 || attachments.some((a) => a.status === 'ready');
}

export function readyAttachmentRefs(
  attachments: PendingChatAttachment[],
): GoogleChatAttachmentDataRef[] {
  return attachments.flatMap((a) => (a.status === 'ready' && a.ref ? [a.ref] : []));
}

/**
 * Put a failed submission's files back into a composer the user has already
 * started a new message in. They go first (they were picked first), ids that
 * are already present are skipped, and anything past the per-message cap is
 * reported as dropped rather than silently lost.
 */
export function restoreFailedAttachments(
  current: PendingChatAttachment[],
  failed: PendingChatAttachment[],
): { attachments: PendingChatAttachment[]; restored: number; dropped: string[] } {
  const present = new Set(current.map((a) => a.id));
  const candidates = failed.filter((a) => !present.has(a.id));
  const room = attachmentSlotsLeft(current);
  const kept = candidates.slice(0, room);
  return {
    attachments: [...kept, ...current],
    restored: kept.length,
    dropped: candidates.slice(room).map((a) => a.name),
  };
}

/** Error line for a failed send whose composer has moved on to a new draft. */
export function failedSendNotice(
  reason: string,
  text: string,
  restored: number,
  dropped: string[],
): string {
  const parts = [reason];
  if (text) parts.push(`Not sent: "${text}"`);
  if (restored) {
    parts.push(
      `${restored} attachment${restored === 1 ? ' was' : 's were'} put back in the composer`,
    );
  }
  if (dropped.length) {
    parts.push(`Attachment limit reached, so these were not kept: ${dropped.join(', ')}`);
  }
  return `${parts.join('. ')}.`;
}

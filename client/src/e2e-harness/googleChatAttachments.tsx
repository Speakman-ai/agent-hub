/**
 * Playwright-only entry: mounts the attachment list on whatever page is open
 * so e2e/tests/google-chat-attachment-viewer.spec.ts can exercise it in real
 * Chromium without the app shell's sign-in flow. Nothing in the app imports it.
 */
import { createRoot } from 'react-dom/client';
import GoogleChatAttachments from '../components/GoogleChatAttachments';
import type { ChatAttachment } from '../utils/googleChat';

export function mount(attachments: ChatAttachment[]) {
  const host = document.createElement('div');
  host.id = 'attachment-harness';
  document.body.appendChild(host);
  createRoot(host).render(
    <GoogleChatAttachments spaceId="AAA" messageId="M1" attachments={attachments} />,
  );
}

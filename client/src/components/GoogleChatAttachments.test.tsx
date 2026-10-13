import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: { fetchGoogleChatAttachment: vi.fn() },
}));

// pdf.js needs a real canvas and worker; the browser-level path is covered in
// e2e/tests/google-chat-attachment-viewer.spec.ts.
vi.mock('./PdfPages', () => ({
  default: ({ data, title }: { data: Blob; title: string }) => (
    <div tabIndex={0} role="document" aria-label={title} data-bytes={data.size} />
  ),
}));

import GoogleChatAttachments from './GoogleChatAttachments';
import { api } from '../utils/api';
import type { ChatAttachment } from '../utils/googleChat';

const fetchAttachment = api.fetchGoogleChatAttachment as unknown as ReturnType<typeof vi.fn>;

function attachment(over: Partial<ChatAttachment>): ChatAttachment {
  return {
    id: 'ATT1',
    contentName: 'shot.png',
    contentType: 'image/png',
    source: 'UPLOADED_CONTENT',
    downloadable: true,
    driveUrl: null,
    ...over,
  };
}

beforeEach(() => {
  fetchAttachment.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('GoogleChatAttachments', () => {
  it('previews an uploaded image through the authenticated content route', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<GoogleChatAttachments spaceId="AAA" messageId="M1" attachments={[attachment({})]} />);
    const img = await screen.findByRole('img', { name: 'shot.png' });
    expect(img).toHaveAttribute('src', 'blob:preview');
    expect(fetchAttachment).toHaveBeenCalledWith('AAA', 'M1', 'ATT1');
  });

  it('falls back to a download chip when the preview fails', async () => {
    fetchAttachment.mockRejectedValue(new Error('403: nope'));
    render(<GoogleChatAttachments spaceId="AAA" messageId="M1" attachments={[attachment({})]} />);
    expect(await screen.findByRole('button', { name: 'Download shot.png' })).toBeInTheDocument();
  });

  it('opens a PDF in the in-app viewer instead of downloading it', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['%PDF']));
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'spec.pdf', contentType: 'application/pdf' })]}
      />,
    );
    expect(fetchAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'spec.pdf' }));
    await screen.findByRole('dialog', { name: 'spec.pdf' });
    // Rendered in this document, not an <iframe> that would own the keyboard.
    const pdf = await screen.findByRole('document', { name: 'spec.pdf' });
    expect(pdf).toHaveAttribute('data-bytes', '4');
    expect(document.querySelector('iframe, embed, object')).toBeNull();
    expect(fetchAttachment).toHaveBeenCalledWith('AAA', 'M1', 'ATT1');

    // Escape typed while the PDF content has focus still closes the viewer.
    pdf.focus();
    expect(document.activeElement).toBe(pdf);
    fireEvent.keyDown(pdf, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps keyboard focus in the viewer and restores it to the trigger on close', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['log line']));
    const { container } = render(
      <>
        <button type="button">background</button>
        <GoogleChatAttachments
          spaceId="AAA"
          messageId="M1"
          attachments={[attachment({ contentName: 'run.log', contentType: 'text/plain' })]}
        />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'run.log' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'run.log' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    expect(container).toHaveAttribute('inert');
    expect(dialog).not.toHaveAttribute('inert');

    await screen.findByText('log line');
    const download = screen.getByRole('button', { name: 'Download' });
    expect(download).toBeEnabled();

    // Tab off the last control wraps to the first, Shift+Tab wraps back.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    // Focus that escaped to the background is pulled back in.
    screen.getByRole('button', { name: 'background' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(download);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container).not.toHaveAttribute('inert');
    expect(document.activeElement).toBe(trigger);
  });

  it('shows text files inline in the viewer', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['hello from the log']));
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'run.log', contentType: null })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'run.log' }));
    expect(await screen.findByText('hello from the log')).toBeInTheDocument();
  });

  it('still downloads a viewable file from its download button', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['%PDF']));
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'spec.pdf', contentType: 'application/pdf' })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download spec.pdf' }));
    await waitFor(() => expect(fetchAttachment).toHaveBeenCalledWith('AAA', 'M1', 'ATT1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads files the viewer cannot show when clicked', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['PK']));
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'bundle.zip', contentType: 'application/zip' })]}
      />,
    );
    expect(fetchAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /bundle\.zip/ }));
    await waitFor(() => expect(fetchAttachment).toHaveBeenCalledWith('AAA', 'M1', 'ATT1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens an image thumbnail in the viewer without refetching', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    render(<GoogleChatAttachments spaceId="AAA" messageId="M1" attachments={[attachment({})]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'shot.png' }));
    expect(await screen.findByRole('dialog', { name: 'shot.png' })).toBeInTheDocument();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('links Drive files out to Drive and never hits the content route', () => {
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[
          attachment({
            contentName: 'Plan',
            contentType: 'application/vnd.google-apps.document',
            source: 'DRIVE_FILE',
            downloadable: false,
            driveUrl: 'https://drive.google.com/open?id=drv1',
          }),
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: /Plan/ })).toHaveAttribute(
      'href',
      'https://drive.google.com/open?id=drv1',
    );
    expect(fetchAttachment).not.toHaveBeenCalled();
  });

  it('does not inline SVG even when it is downloadable', () => {
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'x.svg', contentType: 'image/svg+xml' })]}
      />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /x\.svg/ }));
    // SVG can carry script, so it is a download, never an in-app view.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

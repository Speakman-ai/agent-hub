import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: { fetchGoogleChatAttachment: vi.fn() },
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
    expect(await screen.findByRole('button', { name: /shot\.png/ })).toBeInTheDocument();
  });

  it('downloads non-image files only when clicked', async () => {
    fetchAttachment.mockResolvedValue(new Blob(['%PDF']));
    render(
      <GoogleChatAttachments
        spaceId="AAA"
        messageId="M1"
        attachments={[attachment({ contentName: 'spec.pdf', contentType: 'application/pdf' })]}
      />,
    );
    expect(fetchAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /spec\.pdf/ }));
    await waitFor(() => expect(fetchAttachment).toHaveBeenCalledWith('AAA', 'M1', 'ATT1'));
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
    expect(screen.getByRole('button', { name: /x\.svg/ })).toBeInTheDocument();
  });
});

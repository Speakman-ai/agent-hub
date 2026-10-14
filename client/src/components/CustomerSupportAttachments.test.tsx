import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TicketAttachments, formatAttachmentSize } from './CustomerSupportPage';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    addSupportTicketAttachment: vi.fn(),
    deleteSupportTicketAttachment: vi.fn(),
  },
}));

(vi as any).mock('../utils/connection.js', () => ({
  getServerBase: () => 'https://hub.example.com',
}));

const mockedApi = api as any;

function attachment(overrides: any = {}) {
  return {
    id: 'a1',
    support_ticket_id: 't1',
    ref: '/uploads/support-attachment-a1.png',
    filename: 'shot.png',
    mime: 'image/png',
    size_bytes: 2048,
    created_by: null,
    created_at: '2026-10-14 10:00:00',
    ...overrides,
  };
}

describe('formatAttachmentSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('TicketAttachments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists attachments with resolved links, thumbnails for images, and sizes', () => {
    const ticket = {
      id: 't1',
      attachments: [
        attachment(),
        attachment({
          id: 'a2',
          ref: '/uploads/support-attachment-a2.txt',
          filename: 'console.log',
          mime: 'text/plain',
          size_bytes: 300,
        }),
      ],
    };
    render(<TicketAttachments projectId="p1" ticket={ticket} />);

    expect(screen.getByText('Attachments (2)')).toBeTruthy();
    const items = screen.getAllByTestId('ticket-attachment');
    expect(items).toHaveLength(2);
    expect(screen.getByAltText('shot.png').getAttribute('src')).toBe(
      'https://hub.example.com/uploads/support-attachment-a1.png',
    );
    const logLink = screen.getByText('console.log').closest('a')!;
    expect(logLink.getAttribute('href')).toBe(
      'https://hub.example.com/uploads/support-attachment-a2.txt',
    );
    expect(screen.getByText('300 B')).toBeTruthy();
  });

  it('uploads every picked file, reports per-file failures, and pushes the updated ticket', async () => {
    const updated = { id: 't1', attachments: [attachment()] };
    mockedApi.addSupportTicketAttachment
      .mockResolvedValueOnce({ attachment: attachment(), ticket: updated })
      .mockRejectedValueOnce(new Error('unsupported file type'));
    const onUpdated = vi.fn();
    const onNotify = vi.fn();
    render(
      <TicketAttachments
        projectId="p1"
        ticket={{ id: 't1', attachments: [] }}
        onUpdated={onUpdated}
        onNotify={onNotify}
      />,
    );

    const good = new File(['png'], 'shot.png', { type: 'image/png' });
    const bad = new File(['<html>'], 'page.html', { type: 'text/html' });
    fireEvent.change(screen.getByTestId('attachment-file-input'), {
      target: { files: [good, bad] },
    });

    await waitFor(() => expect(onNotify).toHaveBeenCalled());
    expect(mockedApi.addSupportTicketAttachment).toHaveBeenNthCalledWith(1, 'p1', 't1', good);
    expect(mockedApi.addSupportTicketAttachment).toHaveBeenNthCalledWith(2, 'p1', 't1', bad);
    expect(onUpdated).toHaveBeenCalledWith(updated);
    expect(onNotify).toHaveBeenCalledWith('page.html: unsupported file type', 'error');
  });

  it('removes an attachment only after confirming', async () => {
    const after = { id: 't1', attachments: [] };
    mockedApi.deleteSupportTicketAttachment.mockResolvedValue({ ok: true, ticket: after });
    const onUpdated = vi.fn();
    render(
      <TicketAttachments
        projectId="p1"
        ticket={{ id: 't1', attachments: [attachment()] }}
        onUpdated={onUpdated}
      />,
    );

    fireEvent.click(screen.getByLabelText('Remove shot.png'));
    expect(mockedApi.deleteSupportTicketAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(after));
    expect(mockedApi.deleteSupportTicketAttachment).toHaveBeenCalledWith('p1', 't1', 'a1');
  });
});

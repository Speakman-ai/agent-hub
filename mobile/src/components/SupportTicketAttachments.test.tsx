import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
  Image: 'Image',
  Linking: { openURL: (...args: unknown[]) => mocks.openURL(...args) },
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  openURL: vi.fn().mockResolvedValue(undefined),
  deleteSupportTicketAttachment: vi.fn(),
  getDocumentAsync: vi.fn(),
  uploadSupportTicketAttachments: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  api: { deleteSupportTicketAttachment: mocks.deleteSupportTicketAttachment },
}));
vi.mock('../utils/supportTickets', () => ({
  resolveUploadUrl: (ref: string) => (ref ? `https://hub.test${ref}` : null),
}));
vi.mock('../utils/supportTicketAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/supportTicketAttachments')>()),
  uploadSupportTicketAttachments: mocks.uploadSupportTicketAttachments,
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: mocks.getDocumentAsync }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: SupportTicketAttachments } = await import('./SupportTicketAttachments');
process.env.NODE_ENV = originalNodeEnv;

const att = (id: string, filename: string, mime: string) => ({
  id,
  support_ticket_id: 't1',
  ref: `/uploads/support-attachment-${id}.bin`,
  filename,
  mime,
  size_bytes: 2048,
  created_by: null,
  created_at: '',
});

const flush = () => TestRenderer.act(async () => new Promise((r) => setTimeout(r, 10)));

function render(ticket: any, onUpdated = vi.fn()) {
  let r!: ReturnType<typeof TestRenderer.create>;
  TestRenderer.act(() => {
    r = TestRenderer.create(
      React.createElement(SupportTicketAttachments, { projectId: 'p1', ticket, onUpdated }),
    );
  });
  return r;
}

describe('mobile SupportTicketAttachments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists attachments, opens one on tap, and thumbnails images', () => {
    const r = render({
      id: 't1',
      attachments: [att('a1', 'shot.png', 'image/png'), att('a2', 'app.log', 'text/plain')],
    });
    const rows = r.root.findAll((n) => n.props.testID === 'ticket-attachment');
    expect(rows).toHaveLength(2);
    expect(r.root.findAll((n) => (n.type as unknown) === 'Image')).toHaveLength(1);
    TestRenderer.act(() => {
      rows[1]!.props.onPress();
    });
    expect(mocks.openURL).toHaveBeenCalledWith(
      'https://hub.test/uploads/support-attachment-a2.bin',
    );
  });

  it('uploads every picked document and forwards the updated ticket', async () => {
    mocks.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.png', name: 'a.png' },
        { uri: 'file:///b.log', name: 'b.log' },
      ],
    });
    mocks.uploadSupportTicketAttachments.mockResolvedValue({ uploaded: 2, failures: [] });
    const onUpdated = vi.fn();
    const r = render({ id: 't1', attachments: [] }, onUpdated);

    const add = r.root.find((n) => n.props.testID === 'add-attachments-button');
    await TestRenderer.act(async () => add.props.onPress());
    await flush();

    expect(mocks.getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true }),
    );
    const [projectId, ticketId, files, opts] = mocks.uploadSupportTicketAttachments.mock.calls[0]!;
    expect([projectId, ticketId]).toEqual(['p1', 't1']);
    expect(files.map((f: any) => f.name)).toEqual(['a.png', 'b.log']);
    expect(opts.onTicket).toBe(onUpdated);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('removes an attachment after the confirm alert', async () => {
    mocks.deleteSupportTicketAttachment.mockResolvedValue({ ok: true, ticket: { id: 't1' } });
    const onUpdated = vi.fn();
    const r = render({ id: 't1', attachments: [att('a1', 'shot.png', 'image/png')] }, onUpdated);

    const row = r.root.find((n) => n.props.testID === 'ticket-attachment');
    TestRenderer.act(() => {
      row.props.onLongPress();
    });
    const buttons = mocks.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => any }>;
    await TestRenderer.act(async () => buttons.find((b) => b.text === 'Remove')!.onPress!());

    expect(mocks.deleteSupportTicketAttachment).toHaveBeenCalledWith('p1', 't1', 'a1');
    expect(onUpdated).toHaveBeenCalledWith({ id: 't1' });
  });
});

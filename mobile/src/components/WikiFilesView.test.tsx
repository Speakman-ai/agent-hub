import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  moveWikiFile: vi.fn(),
  deleteWikiFile: vi.fn(),
  listWikiFiles: vi.fn(),
  uploadWikiFile: vi.fn(),
  getDocumentAsync: vi.fn(),
}));
vi.mock('../utils/api', () => ({
  api: {
    listWikiFiles: mocks.listWikiFiles,
    moveWikiFile: mocks.moveWikiFile,
    deleteWikiFile: mocks.deleteWikiFile,
  },
}));
vi.mock('../utils/wikiFileTransfer', () => ({
  uploadWikiFile: mocks.uploadWikiFile,
  shareWikiFile: vi.fn(),
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: mocks.getDocumentAsync }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { default: WikiFilesView } = await import('./WikiFilesView');
process.env.NODE_ENV = originalNodeEnv;

const fileIn = (project: string, filename: string) => ({
  id: `${project}-id`,
  project_id: project,
  folder: '',
  filename,
  path: filename,
  content_type: 'text/plain',
  size_bytes: 1,
  page_id: null,
  page_slug: null,
  extracted_chars: 0,
  truncated: 0,
  uploaded_by: null,
  created_at: '',
  updated_at: '',
});

function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children.filter((c) => typeof c === 'string').join(''));
}

const flush = () => TestRenderer.act(async () => new Promise((r) => setTimeout(r, 10)));

describe('mobile WikiFilesView project isolation', () => {
  it('an upload batch from the previous project finishing late cannot change the new project', async () => {
    mocks.listWikiFiles.mockImplementation(async (project: string) => [
      fileIn(project, `${project}-file.pdf`),
    ]);
    mocks.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///late.md', name: 'late.md' }],
    });
    let finishUpload!: () => void;
    mocks.uploadWikiFile.mockImplementation(() => new Promise<void>((r) => (finishUpload = r)));

    let r!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      r = TestRenderer.create(
        React.createElement(WikiFilesView, { projectId: 'a', onOpenPage: () => {} }),
      );
    });
    await flush();
    expect(texts(r)).toContain('a-file.pdf');

    // Start an upload batch in project A.
    const choose = r.root.find(
      (n) =>
        (n.type as unknown) === 'TouchableOpacity' &&
        n
          .findAll((c) => (c.type as unknown) === 'Text')
          .some((t) => t.children.includes('Choose files')),
    );
    await TestRenderer.act(async () => {
      choose.props.onPress();
    });
    await flush();
    expect(mocks.uploadWikiFile).toHaveBeenCalledWith('a', '', expect.anything());

    // Switch to project B and let its list load.
    await TestRenderer.act(async () => {
      r.update(React.createElement(WikiFilesView, { projectId: 'b', onOpenPage: () => {} }));
    });
    await flush();
    expect(texts(r)).toContain('b-file.pdf');
    // A's in-flight batch is not B's: no busy state carries over.
    expect(texts(r).some((t) => t.includes('late.md'))).toBe(false);
    const listCallsBefore = mocks.listWikiFiles.mock.calls.length;

    // A's upload finishes after B is showing.
    await TestRenderer.act(async () => {
      finishUpload();
    });
    await flush();

    expect(texts(r)).toContain('b-file.pdf');
    expect(texts(r)).not.toContain('a-file.pdf');
    expect(mocks.listWikiFiles.mock.calls.slice(listCallsBefore)).toEqual([]);
  });

  it('under Strict Mode, refreshes the list after an upload, a move, and a delete', async () => {
    mocks.listWikiFiles.mockReset().mockResolvedValue([fileIn('p', 'doc.pdf')]);
    mocks.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///x.md', name: 'x.md' }],
    });
    mocks.uploadWikiFile.mockReset().mockResolvedValue({});
    mocks.moveWikiFile.mockResolvedValue({ folder: 'Archive' });
    mocks.deleteWikiFile.mockResolvedValue({ ok: true });

    let r!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      r = TestRenderer.create(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(WikiFilesView, { projectId: 'p', onOpenPage: () => {} }),
        ),
      );
    });
    await flush();
    const pressText = async (label: string) => {
      const btn = r.root.find(
        (n) =>
          (n.type as unknown) === 'TouchableOpacity' &&
          n
            .findAll((c) => (c.type as unknown) === 'Text')
            .some((t) => t.children.join('') === label),
      );
      await TestRenderer.act(async () => {
        btn.props.onPress();
      });
      await flush();
    };

    let before = mocks.listWikiFiles.mock.calls.length;
    await pressText('Choose files');
    expect(mocks.listWikiFiles.mock.calls.length).toBeGreaterThan(before);

    await pressText('doc.pdf'); // select the file to reveal its actions
    const moveInput = r.root.find(
      (n) =>
        (n.type as unknown) === 'TextInput' &&
        n.props.placeholder === 'Move to folder (blank for root)',
    );
    await TestRenderer.act(async () => {
      moveInput.props.onChangeText('Archive');
    });
    before = mocks.listWikiFiles.mock.calls.length;
    await pressText('Move');
    expect(mocks.moveWikiFile).toHaveBeenCalledWith('p', 'p-id', 'Archive');
    expect(mocks.listWikiFiles.mock.calls.length).toBeGreaterThan(before);

    await pressText('doc.pdf');
    await pressText('Delete');
    const buttons = mocks.alert.mock.calls.at(-1)![2] as {
      text: string;
      onPress?: () => unknown;
    }[];
    before = mocks.listWikiFiles.mock.calls.length;
    await TestRenderer.act(async () => {
      await buttons.find((b) => b.text === 'Delete')!.onPress!();
    });
    await flush();
    expect(mocks.deleteWikiFile).toHaveBeenCalledWith('p', 'p-id');
    expect(mocks.listWikiFiles.mock.calls.length).toBeGreaterThan(before);
  });
});

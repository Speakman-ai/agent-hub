import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WikiFiles from './WikiFiles';

(vi as any).mock('../utils/connection', () => ({
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
}));

const file = {
  id: 'f1',
  project_id: 'proj',
  folder: 'SOPs/Safety',
  filename: 'lockout.pdf',
  path: 'SOPs/Safety/lockout.pdf',
  content_type: 'application/pdf',
  size_bytes: 2048,
  page_id: 'p1',
  page_slug: 'sops-safety-lockout-pdf',
  extracted_chars: 1200,
  truncated: 0,
  uploaded_by: null,
  created_at: '2026-09-26 00:00:00',
  updated_at: '2026-09-26 00:00:00',
};

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('WikiFiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ replaced: false }, 201);
      if (String(url).endsWith('/wiki-files')) return json([file]);
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the folder tree and opens the indexed page', async () => {
    const onOpenPage = vi.fn();
    render(<WikiFiles projectId="proj" apiBase="/api" onOpenPage={onOpenPage} />);

    expect(await screen.findByText('SOPs')).toBeTruthy();
    expect(screen.getByText('Safety')).toBeTruthy();
    fireEvent.click(screen.getByText('lockout.pdf'));
    fireEvent.click(await screen.findByText('View indexed text'));
    expect(onOpenPage).toHaveBeenCalledWith('sops-safety-lockout-pdf');
  });

  it('uploads raw bytes into the typed folder', async () => {
    const { container } = render(
      <WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />,
    );
    await screen.findByText('SOPs');

    fireEvent.change(screen.getByPlaceholderText(/Folder, e.g. SOPs\/Safety/), {
      target: { value: ' HR / Policies ' },
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const upload = new File(['Be kind.'], 'conduct.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [upload] } });

    await waitFor(() => expect(screen.getByText('indexed')).toBeTruthy());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/projects/proj/wiki-files?filename=conduct.md&folder=HR%2FPolicies');
    expect((post[1] as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
      Authorization: 'Bearer test-jwt',
    });
    expect((post[1] as RequestInit).body).toBe(upload);
  });

  it('retries a busy (503) upload after Retry-After', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        if (posts === 1) {
          return {
            ok: false,
            status: 503,
            headers: new Headers({ 'Retry-After': '1' }),
            json: async () => ({ error: 'busy', code: 'busy' }),
          };
        }
        return json({ replaced: false }, 201);
      }
      if (String(url).endsWith('/wiki-files')) return json([file]);
      return json({});
    });
    const { container } = render(
      <WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />,
    );
    await screen.findByText('SOPs');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.md')] } });

    await waitFor(() => expect(screen.getByText(/server busy, retrying in 1s/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('indexed')).toBeTruthy(), { timeout: 3000 });
    expect(posts).toBe(2);
  });

  it('keeps overlapping batches independent when they resolve out of order', async () => {
    let resolveA!: (r: unknown) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (String(url).includes('filename=a.md')) {
          return new Promise((r) => (resolveA = r)); // batch A stays in flight
        }
        return json({ error: 'Unsupported file type' }, 415); // batch B fails fast
      }
      if (String(url).endsWith('/wiki-files')) return json([file]);
      return json({});
    });
    const { container } = render(
      <WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />,
    );
    await screen.findByText('SOPs');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File(['a'], 'a.md')] } }); // batch A
    await waitFor(() => expect(resolveA).toBeTypeOf('function'));
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.png')] } }); // batch B

    const row = (name: string) => screen.getByText(name).closest('li')!;
    await waitFor(() => expect(row('b.png').textContent).toContain('Unsupported file type'));

    // A finishes after B: it must update only its own row.
    resolveA(json({ replaced: false }, 201));
    await waitFor(() => expect(row('a.md').textContent).toContain('indexed'));
    expect(row('b.png').textContent).toContain('Unsupported file type');
    expect(row('b.png').textContent).not.toContain('indexed');
  });

  describe('every action reports its failure', () => {
    async function selectFile() {
      render(<WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />);
      fireEvent.click(await screen.findByText('lockout.pdf'));
      await screen.findByText('Move');
    }

    it('shows a transport failure on move', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
        if (String(url).endsWith('/wiki-files')) return json([file]);
        return json({});
      });
      await selectFile();
      fireEvent.change(screen.getByPlaceholderText('Folder (blank for root)'), {
        target: { value: 'Archive' },
      });
      fireEvent.click(screen.getByText('Move'));
      expect(
        await screen.findByText('Move failed: could not reach the server (Failed to fetch)'),
      ).toBeTruthy();
    });

    it('shows a transport failure on delete', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') throw new TypeError('Network down');
        if (String(url).endsWith('/wiki-files')) return json([file]);
        return json({});
      });
      await selectFile();
      fireEvent.click(screen.getByText('Delete'));
      fireEvent.click(await screen.findByText('Confirm delete'));
      expect(
        await screen.findByText('Delete failed: could not reach the server (Network down)'),
      ).toBeTruthy();
    });

    it('shows the server message when delete returns an HTTP error', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') return json({ error: 'File is locked' }, 500);
        if (String(url).endsWith('/wiki-files')) return json([file]);
        return json({});
      });
      await selectFile();
      fireEvent.click(screen.getByText('Delete'));
      fireEvent.click(await screen.findByText('Confirm delete'));
      expect(await screen.findByText('Delete failed: File is locked')).toBeTruthy();
    });

    it('shows a failed file-list load instead of an empty folder', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      render(<WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />);
      expect(
        await screen.findByText(
          'Loading files failed: could not reach the server (Failed to fetch)',
        ),
      ).toBeTruthy();
    });
  });

  it('ignores a slow list response for a project the user already left', async () => {
    let resolveOld!: (r: unknown) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/projects/old/')) return new Promise((r) => (resolveOld = r));
      if (String(url).includes('/projects/new/')) return json([{ ...file, filename: 'new.pdf' }]);
      return json({});
    });
    const { rerender } = render(<WikiFiles projectId="old" apiBase="/api" onOpenPage={() => {}} />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    rerender(<WikiFiles projectId="new" apiBase="/api" onOpenPage={() => {}} />);
    expect(await screen.findByText('new.pdf')).toBeTruthy();

    resolveOld(json([{ ...file, filename: 'stale.pdf' }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('stale.pdf')).toBeNull();
    expect(screen.getByText('new.pdf')).toBeTruthy();
  });

  it('an upload from the previous project finishing late cannot change the new project', async () => {
    let finishUploadA!: (r: unknown) => void;
    const listCalls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST' && u.includes('/projects/a/')) {
        return new Promise((r) => (finishUploadA = r));
      }
      if (u.endsWith('/projects/a/wiki-files')) {
        listCalls.push('a');
        return json([{ ...file, id: 'fa', filename: 'a-file.pdf', project_id: 'a' }]);
      }
      if (u.endsWith('/projects/b/wiki-files')) {
        listCalls.push('b');
        return json([{ ...file, id: 'fb', filename: 'b-file.pdf', project_id: 'b' }]);
      }
      if (init?.method === 'DELETE') return json({ ok: true });
      return json({});
    });

    const { container, rerender } = render(
      <WikiFiles projectId="a" apiBase="/api" onOpenPage={() => {}} />,
    );
    await screen.findByText('a-file.pdf');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'late.md')] } });
    await waitFor(() => expect(finishUploadA).toBeTypeOf('function'));

    // Switch to project B and let its list load completely.
    rerender(<WikiFiles projectId="b" apiBase="/api" onOpenPage={() => {}} />);
    await screen.findByText('b-file.pdf');
    const callsBeforeLateFinish = listCalls.length;

    // Now A's upload finishes.
    finishUploadA(json({ replaced: false }, 201));
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.getByText('b-file.pdf')).toBeTruthy();
    expect(screen.queryByText('a-file.pdf')).toBeNull();
    expect(screen.queryByText('late.md')).toBeNull(); // A's upload row is not B's
    // A's finished upload did not even start a refresh.
    expect(listCalls.slice(callsBeforeLateFinish)).toEqual([]);

    // Actions in B target B's files with B's project id.
    fireEvent.click(screen.getByText('b-file.pdf'));
    fireEvent.click(await screen.findByText('Delete'));
    fireEvent.click(await screen.findByText('Confirm delete'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            (init as RequestInit | undefined)?.method === 'DELETE' &&
            String(url) === '/api/projects/b/wiki-files/fb',
        ),
      ).toBe(true),
    );
  });

  describe('under React Strict Mode (the app root uses it)', () => {
    // Strict Mode runs effects setup -> cleanup -> setup on mount. Anything that
    // only flips a liveness flag in cleanup ends up permanently "unmounted".
    function renderStrict() {
      return render(
        <StrictMode>
          <WikiFiles projectId="proj" apiBase="/api" onOpenPage={() => {}} />
        </StrictMode>,
      );
    }
    const listCalls = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/wiki-files') && !(init as RequestInit | undefined)?.method,
      ).length;

    it('refreshes the list after an upload, a move, a delete, and a websocket update', async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ replaced: false }, 201);
        if (init?.method === 'PATCH') return json({ ...file, folder: 'Archive' });
        if (init?.method === 'DELETE') return json({ ok: true });
        if (String(url).endsWith('/wiki-files')) return json([file]);
        return json({});
      });
      const { container } = renderStrict();
      await screen.findByText('lockout.pdf');

      let before = listCalls();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['x'], 'new.md')] } });
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));

      before = listCalls();
      fireEvent.click(screen.getAllByText('lockout.pdf')[0]!);
      fireEvent.change(screen.getByPlaceholderText('Folder (blank for root)'), {
        target: { value: 'Archive' },
      });
      fireEvent.click(screen.getByText('Move'));
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));

      before = listCalls();
      fireEvent.click(screen.getAllByText('lockout.pdf')[0]!);
      fireEvent.click(await screen.findByText('Delete'));
      fireEvent.click(await screen.findByText('Confirm delete'));
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));

      before = listCalls();
      window.dispatchEvent(new CustomEvent('wiki_files_update', { detail: { projectId: 'proj' } }));
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    });

    it('keeps retrying a busy (503) upload', async () => {
      let posts = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts++;
          if (posts === 1) {
            return {
              ok: false,
              status: 503,
              headers: new Headers({ 'Retry-After': '1' }),
              json: async () => ({ error: 'busy' }),
            };
          }
          return json({ replaced: false }, 201);
        }
        if (String(url).endsWith('/wiki-files')) return json([file]);
        return json({});
      });
      const { container } = renderStrict();
      await screen.findByText('lockout.pdf');
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.md')] } });
      await waitFor(() => expect(screen.getByText('indexed')).toBeTruthy(), { timeout: 3000 });
      expect(posts).toBe(2);
    });
  });
});

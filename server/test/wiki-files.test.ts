import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import { makePdf, makeDocx } from './wiki-file-fixtures.js';
import {
  normalizeWikiFolder,
  normalizeWikiFilename,
  WikiFileInputError,
  saveWikiFile,
  listWikiFiles,
  purgeProjectWikiFiles,
  wikiUploadGate,
  wikiDownloadGate,
  setWikiFileStoreOverride,
  MAX_WIKI_FILE_BYTES,
} from '../wiki-files.js';
import http from 'http';
import type { AddressInfo } from 'net';
import { getApp } from './helpers.js';
import { getDb } from '../db.js';
import type { UploadStore } from '../upload-store.js';
import {
  embedPage,
  embedQueueStats,
  whenEmbedsIdle,
  scheduleEmbedPage,
  MAX_CONCURRENT_EMBEDS,
  EMBED_BATCH_SIZE,
  setEmbedClient,
  type EmbedClient,
} from '../wiki-embeddings.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
}, 60_000);

function upload(
  filename: string,
  body: Buffer | string,
  opts: { folder?: string; contentType?: string } = {},
) {
  const q = new URLSearchParams({ filename });
  if (opts.folder !== undefined) q.set('folder', opts.folder);
  return request
    .post(`/api/projects/${projectId}/wiki-files?${q.toString()}`)
    .set('Content-Type', opts.contentType ?? 'application/octet-stream')
    .send(body);
}

describe('folder / filename normalization', () => {
  it('collapses slashes, backslashes, and dot segments', () => {
    expect(normalizeWikiFolder(' /SOPs\\\\Safety/./ Lockout /')).toBe('SOPs/Safety/Lockout');
    expect(normalizeWikiFolder('')).toBe('');
    expect(normalizeWikiFolder(undefined)).toBe('');
  });

  it('rejects parent traversal', () => {
    expect(() => normalizeWikiFolder('SOPs/../secrets')).toThrow(WikiFileInputError);
  });

  it('keeps only the basename of a filename', () => {
    expect(normalizeWikiFilename('C:\\\\Users\\\\me\\\\sop.pdf')).toBe('sop.pdf');
    expect(normalizeWikiFilename('../../etc/passwd')).toBe('passwd');
    expect(() => normalizeWikiFilename('  ')).toThrow(WikiFileInputError);
  });
});

describe('wiki file upload routes', () => {
  it('uploads a PDF into a folder and indexes its text as a documents page', async () => {
    // Sent as octet-stream (what web/mobile do); the stored type comes from the extension.
    const res = await upload('forklift.pdf', makePdf('Forklift daily inspection'), {
      folder: 'SOPs/Warehouse',
    }).expect(201);

    expect(res.body.replaced).toBe(false);
    expect(res.body.file.path).toBe('SOPs/Warehouse/forklift.pdf');
    expect(res.body.file.folder).toBe('SOPs/Warehouse');
    expect(res.body.file.page_slug).toBe(res.body.page.slug);
    expect(res.body.file.content_type).toBe('application/pdf');

    const page = await request.get(`/api/projects/${projectId}/wiki/${res.body.page.slug}`);
    expect(page.status).toBe(200);
    expect(page.body.category).toBe('documents');
    expect(page.body.content).toContain('Forklift daily inspection');

    const hits = await request
      .get(`/api/projects/${projectId}/wiki/search`)
      .query({ q: 'forklift', mode: 'fts' })
      .expect(200);
    expect(hits.body.results.map((r: { slug: string }) => r.slug)).toContain(res.body.page.slug);
  });

  it('stores a .json upload as raw bytes even when sent as application/json', async () => {
    const json = '{\n  "step": "verify zero energy"\n}';
    const res = await upload('checklist.json', json, {
      folder: 'SOPs',
      contentType: 'application/json',
    }).expect(201);
    const dl = await request
      .get(`/api/projects/${projectId}/wiki-files/${res.body.file.id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((dl.body as Buffer).toString('utf8')).toBe(json);
    expect(dl.headers['content-disposition']).toContain('checklist.json');
  });

  it('replaces the file and rewrites the same page on re-upload', async () => {
    const first = await upload('shutdown.docx', await makeDocx(['Old procedure']), {
      folder: 'SOPs/Plant',
    }).expect(201);
    const second = await upload('shutdown.docx', await makeDocx(['New procedure v2']), {
      folder: 'SOPs/Plant',
    }).expect(200);

    expect(second.body.replaced).toBe(true);
    expect(second.body.file.id).toBe(first.body.file.id);
    expect(second.body.page.slug).toBe(first.body.page.slug);
    const page = await request.get(`/api/projects/${projectId}/wiki/${second.body.page.slug}`);
    expect(page.body.content).toContain('New procedure v2');
    expect(second.body.file.content_type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(page.body.content).not.toContain('Old procedure');
  });

  it('does not overwrite a hand-written page that owns the same slug', async () => {
    await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: 'handbook.md', content: 'hand written' })
      .expect(201);
    const res = await upload('handbook.md', '# Handbook\n\nuploaded').expect(201);
    expect(res.body.page.slug).not.toBe('handbook-md');
    const original = await request.get(`/api/projects/${projectId}/wiki/handbook-md`);
    expect(original.body.content).toBe('hand written');
  });

  it('lists files, filters by folder, and moves between folders', async () => {
    const all = await request.get(`/api/projects/${projectId}/wiki-files`).expect(200);
    const paths = all.body.map((f: { path: string }) => f.path);
    expect(paths).toContain('SOPs/Warehouse/forklift.pdf');

    const inPlant = await request
      .get(`/api/projects/${projectId}/wiki-files`)
      .query({ folder: 'SOPs/Plant' })
      .expect(200);
    expect(inPlant.body.map((f: { filename: string }) => f.filename)).toEqual(['shutdown.docx']);

    const id = inPlant.body[0].id as string;
    const moved = await request
      .patch(`/api/projects/${projectId}/wiki-files/${id}`)
      .send({ folder: 'Archive' })
      .expect(200);
    expect(moved.body.path).toBe('Archive/shutdown.docx');
    expect(moved.body).not.toHaveProperty('extracted_text');
  });

  it('rewrites the linked page to the new path on move, keeping its slug', async () => {
    const up = await upload('evac.md', '# Evacuation\n\nMeet at the north lot.', {
      folder: 'SOPs/Fire',
    }).expect(201);
    const slug = up.body.page.slug as string;

    await request
      .patch(`/api/projects/${projectId}/wiki-files/${up.body.file.id}`)
      .send({ folder: 'Archive/Retired' })
      .expect(200);

    const page = await request.get(`/api/projects/${projectId}/wiki/${slug}`).expect(200);
    expect(page.body.slug).toBe(slug);
    expect(page.body.title).toBe('Archive/Retired/evac.md');
    expect(page.body.content).toContain('**Archive/Retired/evac.md**');
    expect(page.body.content).not.toContain('SOPs/Fire');
    expect(page.body.content).toContain('Meet at the north lot.');

    const hits = await request
      .get(`/api/projects/${projectId}/wiki/search`)
      .query({ q: 'Retired', mode: 'fts' })
      .expect(200);
    expect(hits.body.results.map((r: { slug: string }) => r.slug)).toContain(slug);
    const stale = await request
      .get(`/api/projects/${projectId}/wiki/search`)
      .query({ q: '"SOPs/Fire"', mode: 'fts' })
      .expect(200);
    expect(stale.body.results.map((r: { slug: string }) => r.slug)).not.toContain(slug);

    // A later re-upload at the new path still targets the same page.
    const again = await upload('evac.md', '# Evacuation\n\nMeet at the south lot.', {
      folder: 'Archive/Retired',
    }).expect(200);
    expect(again.body.page.slug).toBe(slug);
  });

  it('refuses edits to a file-generated page, so a later move cannot discard them', async () => {
    const up = await upload('ppe.md', '# PPE\n\nWear gloves.', { folder: 'SOPs/PPE' }).expect(201);
    const slug = up.body.page.slug as string;

    const page = await request.get(`/api/projects/${projectId}/wiki/${slug}`).expect(200);
    expect(page.body.source_file).toEqual({ id: up.body.file.id, path: 'SOPs/PPE/ppe.md' });

    const edit = await request
      .put(`/api/projects/${projectId}/wiki/${slug}`)
      .send({ content: 'Wear gloves and goggles.' })
      .expect(409);
    expect(edit.body.code).toBe('file_backed_page');
    await request
      .put(`/api/projects/${projectId}/wiki/${slug}`)
      .send({ title: 'Renamed' })
      .expect(409);

    await request
      .patch(`/api/projects/${projectId}/wiki-files/${up.body.file.id}`)
      .send({ folder: 'SOPs/Safety' })
      .expect(200);
    const after = await request.get(`/api/projects/${projectId}/wiki/${slug}`).expect(200);
    expect(after.body.content).toContain('Wear gloves.');
    expect(after.body.content).not.toContain('goggles');
    expect(after.body.source_file.path).toBe('SOPs/Safety/ppe.md');

    // Normal pages still report no source file and stay editable.
    const plain = await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: `Plain ${Date.now()}`, content: 'x' })
      .expect(201);
    const plainGet = await request.get(`/api/projects/${projectId}/wiki/${plain.body.slug}`);
    expect(plainGet.body.source_file).toBeNull();
    await request
      .put(`/api/projects/${projectId}/wiki/${plain.body.slug}`)
      .send({ content: 'y' })
      .expect(200);
  });

  it('project import skips pages generated from uploaded files', async () => {
    const up = await upload('import.md', 'original text', { folder: 'Imp' }).expect(201);
    const slug = up.body.page.slug as string;
    const res = await request
      .post(`/api/projects/${projectId}/import`)
      .send({
        version: 3,
        type: 'project',
        wiki: [{ slug, title: 'Hijacked', content: 'overwritten', category: 'general' }],
      })
      .expect(200);
    expect(res.body.results.wiki).toMatch(/1 skipped/);
    const page = await request.get(`/api/projects/${projectId}/wiki/${slug}`).expect(200);
    expect(page.body.content).toContain('original text');
    expect(page.body.title).toBe('Imp/import.md');
  });

  it('does not shadow an existing wiki page whose slug is "files"', async () => {
    await request
      .post(`/api/projects/${projectId}/wiki`)
      .send({ title: 'Files', content: 'Where we keep shared drives.' })
      .expect(201);
    const page = await request.get(`/api/projects/${projectId}/wiki/files`).expect(200);
    expect(page.body.slug).toBe('files');
    expect(page.body.content).toBe('Where we keep shared drives.');

    const list = await request.get(`/api/projects/${projectId}/wiki-files`).expect(200);
    expect(Array.isArray(list.body)).toBe(true);
  });

  it('rejects unsupported types, empty bodies, and traversal', async () => {
    await upload('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      contentType: 'image/png',
    }).expect(415);
    await upload('empty.txt', Buffer.alloc(0)).expect(400);
    await upload('a.txt', 'hi', { folder: '../escape' }).expect(400);
    await request
      .post(`/api/projects/${projectId}/wiki-files`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'))
      .expect(400);
  });

  it('deletes the file together with its indexed page', async () => {
    const res = await upload('temp.txt', 'temporary note', { folder: 'Scratch' }).expect(201);
    const slug = res.body.page.slug as string;
    await request.delete(`/api/projects/${projectId}/wiki-files/${res.body.file.id}`).expect(200);
    await request.get(`/api/projects/${projectId}/wiki/${slug}`).expect(404);
    await request
      .get(`/api/projects/${projectId}/wiki-files/${res.body.file.id}/download`)
      .expect(404);
  });

  it('unlinks, rather than orphans, a file whose page is deleted by hand', async () => {
    const res = await upload('keep.txt', 'keep me', { folder: 'Scratch' }).expect(201);
    await request.delete(`/api/projects/${projectId}/wiki/${res.body.page.slug}`).expect(200);
    const files = await request
      .get(`/api/projects/${projectId}/wiki-files`)
      .query({ folder: 'Scratch' })
      .expect(200);
    const file = files.body.find((f: { id: string }) => f.id === res.body.file.id);
    expect(file.page_id).toBeNull();
    expect(file.page_slug).toBeNull();
  });
});

describe('embedPage batching for long documents', () => {
  const prevKey = process.env.GEMINI_API_KEY;
  afterAll(() => {
    setEmbedClient(null);
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  });

  it('never sends more than EMBED_BATCH_SIZE texts per embed call', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const batchSizes: number[] = [];
    const client: EmbedClient = {
      async embedTexts(texts) {
        batchSizes.push(texts.length);
        return texts.map(() => ({ values: [1, 0, 0] }));
      },
    };
    const paragraphs = Array.from({ length: 250 }, (_, i) => `Para ${i} ${'word '.repeat(600)}`);
    const res = await embedPage(
      projectId,
      { id: 'batch-test-page', title: 'Big SOP', content: paragraphs.join('\n\n') },
      client,
    );
    expect(res.error).toBeUndefined();
    expect(res.chunks).toBeGreaterThan(EMBED_BATCH_SIZE);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
  });
});

/** In-memory store whose `put` resolves only after every pending put has been issued. */
function gatedStore(expectedPuts: number) {
  const objects = new Map<string, Buffer>();
  let pending: (() => void)[] = [];
  const store: UploadStore = {
    kind: 'local',
    async put(name, body) {
      objects.set(name, body);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === expectedPuts) {
          const release = pending;
          pending = [];
          release.forEach((r) => r());
        }
      });
    },
    async getBytes(name) {
      return objects.get(name) ?? null;
    },
    async delete(name) {
      objects.delete(name);
    },
    async presignGet() {
      return null;
    },
  };
  return { store, objects };
}

function documentPagesTitled(prefix: string): { id: string; title: string }[] {
  return getDb()
    .prepare(
      "SELECT id, title FROM wiki_pages WHERE project_id = ? AND category = 'documents' AND title LIKE ?",
    )
    .all(projectId, `${prefix}%`) as { id: string; title: string }[];
}

describe('concurrent uploads to the same path', () => {
  it('leaves exactly one file row, one linked page, and one stored object', async () => {
    const { store, objects } = gatedStore(2);
    // Both uploads finish extraction and reach store.put before either commits.
    const results = await Promise.all([
      saveWikiFile(projectId, store, {
        folder: 'Race',
        filename: 'same.txt',
        contentType: 'text/plain',
        body: Buffer.from('first revision'),
      }),
      saveWikiFile(projectId, store, {
        folder: 'Race',
        filename: 'same.txt',
        contentType: 'text/plain',
        body: Buffer.from('second revision'),
      }),
    ]);

    expect(results.map((r) => r.replaced).sort()).toEqual([false, true]);
    expect(results[0].file.id).toBe(results[1].file.id);
    expect(results[0].page.slug).toBe(results[1].page.slug);

    const rows = listWikiFiles(projectId, 'Race');
    expect(rows).toHaveLength(1);
    expect(documentPagesTitled('Race/same.txt')).toHaveLength(1);
    expect([...objects.keys()]).toEqual([rows[0]!.storage_key]);
  });

  it('rolls back the page and deletes stored bytes when the commit fails', async () => {
    const { store, objects } = gatedStore(1);
    getDb().exec(`CREATE TEMP TRIGGER wiki_files_boom BEFORE INSERT ON main.wiki_files
      WHEN NEW.filename = 'boom.txt' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      await expect(
        saveWikiFile(projectId, store, {
          folder: 'Race',
          filename: 'boom.txt',
          contentType: 'text/plain',
          body: Buffer.from('never indexed'),
        }),
      ).rejects.toThrow('boom');
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS wiki_files_boom');
    }
    expect(documentPagesTitled('Race/boom.txt')).toHaveLength(0);
    expect(objects.size).toBe(0);
    const fts = getDb()
      .prepare("SELECT count(*) AS n FROM wiki_pages_fts WHERE title = 'Race/boom.txt'")
      .get() as { n: number };
    expect(fts.n).toBe(0);
  });
});

describe('purgeProjectWikiFiles', () => {
  it('removes every file row and its stored bytes for the project only', async () => {
    const other = (await createProject()).id as string;
    const { store, objects } = gatedStore(1);
    await saveWikiFile(other, store, {
      folder: 'Gone',
      filename: 'a.txt',
      contentType: 'text/plain',
      body: Buffer.from('bye'),
    });
    expect(objects.size).toBe(1);
    const before = listWikiFiles(projectId).length;

    purgeProjectWikiFiles(other, store);
    await new Promise((r) => setImmediate(r));

    expect(listWikiFiles(other)).toHaveLength(0);
    expect(objects.size).toBe(0);
    expect(listWikiFiles(projectId)).toHaveLength(before);
  });
});

describe('upload admission on the real route', () => {
  it('answers 503 + Retry-After when upload capacity is saturated, then recovers', async () => {
    const { maxActive, maxQueued } = wikiUploadGate.opts;
    const releases = await Promise.all(
      Array.from({ length: maxActive }, () => wikiUploadGate.acquire()),
    );
    const queued = Array.from({ length: maxQueued }, () => wikiUploadGate.acquire());
    try {
      const res = await upload('busy.txt', 'hello').expect(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.code).toBe('busy');
      expect(listWikiFiles(projectId).some((f) => f.filename === 'busy.txt')).toBe(false);
    } finally {
      releases.forEach((r) => r());
      // Release each queued slot as it is admitted (they admit one another).
      await Promise.all(queued.map((q) => q.then((r) => r())));
    }
    expect(wikiUploadGate.stats).toEqual({ active: 0, queued: 0 });
    await upload('busy.txt', 'hello').expect(201);
    expect(wikiUploadGate.stats).toEqual({ active: 0, queued: 0 });
  });

  it('rejects an oversized Content-Length before admitting or reading the body', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/wiki-files?filename=huge.txt`)
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', String(MAX_WIKI_FILE_BYTES + 1))
      .send(Buffer.alloc(16))
      .catch((err: { response?: supertest.Response }) => err.response);
    expect(res?.status).toBe(413);
    expect(wikiUploadGate.stats).toEqual({ active: 0, queued: 0 });
  });
});

describe('background embed queue is bounded', () => {
  const prevKey = process.env.GEMINI_API_KEY;
  afterAll(() => {
    setEmbedClient(null);
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  });

  it('caps concurrent embeds, coalesces repeat saves, and skips vanished pages', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let inFlight = 0;
    let peak = 0;
    const seenTexts: string[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => (unblock = r));
    setEmbedClient({
      async embedTexts(texts) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        seenTexts.push(texts.join(' '));
        await blocked;
        inFlight--;
        return texts.map(() => ({ values: [1, 0] }));
      },
    });

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request
        .post(`/api/projects/${projectId}/wiki`)
        .send({ title: `Embed queue ${Date.now()} ${i}`, content: `body ${i}` })
        .expect(201);
      ids.push(res.body.id);
    }
    // Hammer one page: 50 schedules coalesce into a single pending entry.
    for (let i = 0; i < 50; i++) scheduleEmbedPage(projectId, { id: ids[5]! });
    // A page id that does not exist is dropped when its turn comes.
    scheduleEmbedPage(projectId, { id: 'no-such-page' });

    await vi.waitFor(() => expect(embedQueueStats().running).toBe(MAX_CONCURRENT_EMBEDS));
    expect(embedQueueStats().pending).toBeLessThanOrEqual(ids.length + 1);

    unblock();
    await whenEmbedsIdle();
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_EMBEDS);
    expect(embedQueueStats()).toEqual({ pending: 0, running: 0 });
    // One embed per distinct page (the 50 repeats collapsed; the ghost ran nothing).
    expect(seenTexts.length).toBe(ids.length);
  });
});

describe('admission is held until route work actually finishes', () => {
  /** Store whose put/getBytes block until released, recording what it holds. */
  function blockingStore() {
    const objects = new Map<string, Buffer>();
    let unblock!: () => void;
    const gateP = new Promise<void>((r) => (unblock = r));
    let putStarted = false;
    let getStarted = false;
    const store: UploadStore = {
      kind: 'local',
      async put(name, body) {
        putStarted = true;
        await gateP;
        objects.set(name, body);
      },
      async getBytes(name) {
        getStarted = true;
        await gateP;
        return objects.get(name) ?? Buffer.from('seeded');
      },
      async delete(name) {
        objects.delete(name);
      },
      async presignGet() {
        return null;
      },
    };
    return {
      store,
      objects,
      unblock: () => unblock(),
      putStarted: () => putStarted,
      getStarted: () => getStarted,
    };
  }

  async function listen() {
    const server = http.createServer(await getApp());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: (server.address() as AddressInfo).port };
  }

  afterAll(() => setWikiFileStoreOverride(null));

  it('upload: disconnect while storage is blocked keeps the slot and commits nothing', async () => {
    const blocked = blockingStore();
    setWikiFileStoreOverride(blocked.store);
    const { server, port } = await listen();
    try {
      const body = Buffer.from('slow storage body');
      const req = http.request({
        port,
        host: '127.0.0.1',
        method: 'POST',
        path: `/api/projects/${projectId}/wiki-files?filename=slow.txt&folder=Blocked`,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
      });
      req.on('error', () => {});
      req.end(body); // whole body sent and parsed
      await vi.waitFor(() => expect(blocked.putStarted()).toBe(true));
      expect(wikiUploadGate.stats.active).toBe(1);

      req.destroy(); // client gives up mid store.put
      await new Promise((r) => setTimeout(r, 50));
      // The buffered body is still referenced by the pending put: slot held.
      expect(wikiUploadGate.stats.active).toBe(1);

      blocked.unblock();
      await vi.waitFor(() => expect(wikiUploadGate.stats.active).toBe(0));
      // Cancelled after storing: the bytes are cleaned up and no file is committed.
      expect(blocked.objects.size).toBe(0);
      expect(listWikiFiles(projectId, 'Blocked')).toHaveLength(0);
    } finally {
      blocked.unblock();
      setWikiFileStoreOverride(null);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('download: disconnect while getBytes is blocked keeps the slot until the read ends', async () => {
    const file = (await upload('dl.txt', 'download me', { folder: 'Blocked' }).expect(201)).body
      .file;
    const blocked = blockingStore();
    setWikiFileStoreOverride(blocked.store);
    const { server, port } = await listen();
    try {
      const req = http.get({
        port,
        host: '127.0.0.1',
        path: `/api/projects/${projectId}/wiki-files/${file.id}/download`,
      });
      req.on('error', () => {});
      await vi.waitFor(() => expect(blocked.getStarted()).toBe(true));
      expect(wikiDownloadGate.stats.active).toBe(1);

      req.destroy();
      await new Promise((r) => setTimeout(r, 50));
      expect(wikiDownloadGate.stats.active).toBe(1);

      blocked.unblock();
      await vi.waitFor(() => expect(wikiDownloadGate.stats.active).toBe(0));
    } finally {
      blocked.unblock();
      setWikiFileStoreOverride(null);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

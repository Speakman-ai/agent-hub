import express, { Router, Request, Response, NextFunction } from 'express';
import type { z } from 'zod';
import {
  listPages,
  getPage,
  createPage,
  updatePage,
  deletePage,
  searchPages,
  CATEGORIES as WIKI_CATEGORIES,
  getPageSourceFile,
  FileBackedPageError,
} from '../wiki.js';
import {
  searchWiki,
  backfillProject,
  isGeminiConfigured,
  type SearchMode,
} from '../wiki-embeddings.js';
import type { KanbanBoardRow, KanbanCardRow, RouteDeps } from '../types.js';
import {
  CreateWikiPageRequestSchema,
  UpdateWikiPageRequestSchema,
  ListWikiPagesQuerySchema,
  SearchWikiQuerySchema,
  DocumentBackfillRequestSchema,
  WikiScanRequestSchema,
  ListWikiFilesQuerySchema,
  UploadWikiFileQuerySchema,
  MoveWikiFileRequestSchema,
} from './wiki.openapi.js';
import {
  listWikiFiles,
  getWikiFile,
  saveWikiFile,
  moveWikiFile,
  deleteWikiFile,
  WikiFileInputError,
  MAX_WIKI_FILE_BYTES,
  getWikiFileStore,
  wikiUploadGate,
  wikiDownloadGate,
} from '../wiki-files.js';
import {
  admitted,
  AdmissionRejectedError,
  RequestCancelledError,
  sendAdmissionRejected,
} from '../upload-admission.js';
import { UnsupportedWikiFileError, WikiFileTooLargeError } from '../wiki-file-extract.js';
import { validateUploadContent } from '../upload-validation.js';
import type { UploadStore } from '../upload-store.js';
import {
  dispatchWikiDocBackfill,
  dispatchWikiDocScan,
  isWikiDocSkip,
  maybeMarkLinkedCardDocumented,
} from '../wiki-doc-session.js';
import { resolveCardSessionId } from '../kanban-caller-session.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `board.ts` so the wire shape of validation
 * failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

/**
 * Same as `parseBody` but for `req.query`. Express delivers query values
 * as `string | string[] | undefined` so the schema is responsible for any
 * coercion (see `LimitQuery` in `wiki.openapi.ts`).
 */
function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

export default function createWikiRoutes({
  findProject,
  findAgent,
  broadcast,
  stmts,
  handleChat,
  config,
  serverDir,
}: RouteDeps): Router {
  const router = Router({ mergeParams: true });
  const getFileStore = (): UploadStore => getWikiFileStore(config, serverDir);

  function stampLinkedCardDocumented(req: Request, projectId: string): void {
    const sessionId = resolveCardSessionId(req, undefined);
    const result = maybeMarkLinkedCardDocumented(stmts, sessionId);
    if (result.marked) {
      broadcast({ type: 'kanban_update', projectId });
    }
  }

  router.get('/api/projects/:projectId/wiki', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseQuery(ListWikiPagesQuerySchema, req, res);
    if (!parsed) return;

    if (parsed.q) {
      // Legacy `?q=` keeps returning FTS5 results so the wiki-search skill and
      // any existing callers aren't disturbed. New callers should hit the
      // dedicated `/wiki/search` endpoint below for hybrid/semantic modes.
      res.json(searchPages(projectId, parsed.q, parsed.limit ?? 10));
    } else if (parsed.category) {
      res.json(stmts.getWikiPagesByCategory.all(projectId, parsed.category));
    } else {
      res.json(listPages(projectId));
    }
  });

  // New hybrid/semantic/fts search endpoint. Defaults to hybrid; falls back
  // to pure FTS if the Gemini API key is missing or the query embed fails.
  router.get('/api/projects/:projectId/wiki/search', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseQuery(SearchWikiQuerySchema, req, res);
    if (!parsed) return;

    const q = parsed.q?.trim();
    if (!q)
      return res.json({ mode: 'hybrid', results: [], geminiConfigured: isGeminiConfigured() });

    const mode: SearchMode = parsed.mode ?? 'hybrid';
    const rawLimit = parsed.limit ?? 10;
    const limit = Math.min(Math.max(rawLimit, 1), 50);

    try {
      const results = await searchWiki(projectId, q, { mode, limit });
      res.json({ mode, query: q, geminiConfigured: isGeminiConfigured(), results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Idempotent backfill: re-embed every page in the project. Useful after
  // provisioning the API key for the first time, or after changing the
  // embedding model.
  router.post('/api/projects/:projectId/wiki/reembed', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!isGeminiConfigured()) {
      return res.status(503).json({
        error: 'Gemini API key not configured. Set GEMINI_API_KEY or config.geminiApiKey.',
      });
    }

    try {
      const result = await backfillProject(projectId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // On-demand historical wiki review. Not a scheduled drain: the operator
  // (or an agent they asked) starts a docs session over the oldest
  // undocumented Done cards. Forward coverage is merge-driven.
  router.post('/api/projects/:projectId/wiki/document-backfill', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsedBody = DocumentBackfillRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const first = parsedBody.error.issues[0];
      return res.status(400).json({
        error: first?.message ?? 'Validation failed',
        details: parsedBody.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const limit = parsedBody.data.limit ?? 10;

    const docsAgent = project.agents?.find((a) => (a.role ?? '').trim().toLowerCase() === 'docs');
    if (!docsAgent) {
      return res.status(404).json({
        error:
          'No docs agent found for this project. A docs agent is required to backfill wiki coverage.',
      });
    }

    const board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
    const cards = board
      ? (stmts.listUndocumentedCards.all(board.id, limit) as KanbanCardRow[])
      : [];

    const outcome = dispatchWikiDocBackfill(
      { stmts, config, findProject, findAgent, handleChat, broadcast },
      {
        project,
        cards: cards.map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          updated_at: c.updated_at,
        })),
        ownerUserId: resolveOwnerUserId(req as AuthenticatedRequest),
      },
    );

    if (isWikiDocSkip(outcome)) {
      if (outcome.reason === 'none_undocumented') {
        return res.json({ skipped: true, reason: 'none_undocumented', queued: 0 });
      }
      if (outcome.reason === 'no_docs_agent') {
        return res.status(404).json({
          error:
            'No docs agent found for this project. A docs agent is required to backfill wiki coverage.',
        });
      }
      return res.status(409).json({ error: `Wiki backfill skipped: ${outcome.reason}` });
    }

    res.status(outcome.reused ? 200 : 201).json({
      skipped: false,
      reused: outcome.reused,
      sessionId: outcome.sessionId,
      agentId: outcome.agentId,
      queued: cards.length,
    });
  });

  // "Scan for updates": the docs agent audits the wiki against the codebase
  // and in-repo docs, then adds or updates a bounded number of pages.
  router.post('/api/projects/:projectId/wiki/scan', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsedBody = WikiScanRequestSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const first = parsedBody.error.issues[0];
      return res.status(400).json({
        error: first?.message ?? 'Validation failed',
        details: parsedBody.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const maxChanges = parsedBody.data.maxChanges ?? 5;
    const pages = listPages(projectId);

    const outcome = dispatchWikiDocScan(
      { stmts, config, findProject, findAgent, handleChat, broadcast },
      {
        project,
        pages: pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          category: p.category,
          updated_at: p.updated_at,
        })),
        maxChanges,
        ownerUserId: resolveOwnerUserId(req as AuthenticatedRequest),
      },
    );

    if (isWikiDocSkip(outcome)) {
      if (outcome.reason === 'no_docs_agent') {
        return res.status(404).json({
          error: 'No docs agent found for this project. Add an agent with the docs role to scan.',
        });
      }
      return res.status(409).json({ error: `Wiki scan skipped: ${outcome.reason}` });
    }

    res.status(outcome.reused ? 200 : 201).json({
      reused: outcome.reused,
      sessionId: outcome.sessionId,
      agentId: outcome.agentId,
      pageCount: pages.length,
      maxChanges,
    });
  });

  router.get('/api/projects/:projectId/wiki/categories', (_req: Request, res: Response) => {
    res.json(WIKI_CATEGORIES);
  });

  // Uploaded files live under `/wiki-files`, outside the `/wiki/:slug`
  // namespace, so no route here can shadow a page whose slug is `files`.
  router.get('/api/projects/:projectId/wiki-files', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) return res.status(404).json({ error: 'Project not found' });
    const parsed = parseQuery(ListWikiFilesQuerySchema, req, res);
    if (!parsed) return;
    try {
      res.json(listWikiFiles(projectId, parsed.folder));
    } catch (err) {
      if (err instanceof WikiFileInputError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  router.post(
    '/api/projects/:projectId/wiki-files',
    // Cheap rejections first, then admission, then (only once admitted) the
    // body parser. Waiting requests never buffer their bodies.
    (req: Request, res: Response, next: NextFunction) => {
      if (!findProject(req.params.projectId as string)) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_WIKI_FILE_BYTES) {
        res.setHeader('Connection', 'close');
        return res
          .status(413)
          .json({ error: `File too large. Max size: ${MAX_WIKI_FILE_BYTES / 1024 / 1024}MB` });
      }
      next();
    },
    admitted(
      wikiUploadGate,
      [express.raw({ type: () => true, limit: MAX_WIKI_FILE_BYTES })],
      async (req: Request, res: Response, signal: AbortSignal) => {
        const projectId = req.params.projectId as string;
        const parsed = parseQuery(UploadWikiFileQuerySchema, req, res);
        if (!parsed) return;

        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const contentType = (req.headers['content-type'] as string | undefined) || '';
        const rejectReason = body.length > 0 ? validateUploadContent(contentType, body) : null;
        if (rejectReason) {
          res.status(400).json({ error: rejectReason });
          return;
        }

        try {
          const result = await saveWikiFile(projectId, getFileStore(), {
            folder: parsed.folder,
            filename: parsed.filename,
            contentType,
            body,
            uploadedBy: resolveOwnerUserId(req as AuthenticatedRequest),
            signal,
          });
          stampLinkedCardDocumented(req, projectId);
          broadcast({ type: 'wiki_update', projectId, page: result.page });
          broadcast({ type: 'wiki_files_update', projectId });
          res.status(result.replaced ? 200 : 201).json(result);
        } catch (err) {
          if (err instanceof RequestCancelledError) return;
          if (err instanceof WikiFileInputError) {
            const tooLarge = err.message.startsWith('File too large');
            res.status(tooLarge ? 413 : 400).json({ error: err.message });
          } else if (err instanceof WikiFileTooLargeError) {
            res.status(413).json({ error: err.message });
          } else if (err instanceof UnsupportedWikiFileError) {
            res.status(415).json({ error: err.message });
          } else if (err instanceof AdmissionRejectedError) {
            sendAdmissionRejected(res, err);
          } else {
            console.warn('[wiki-files] upload failed:', (err as Error).message);
            res.status(422).json({ error: `Could not read file: ${(err as Error).message}` });
          }
        }
      },
    ),
  );

  router.get(
    '/api/projects/:projectId/wiki-files/:fileId/download',
    admitted(wikiDownloadGate, [], async (req: Request, res: Response, signal: AbortSignal) => {
      const file = getWikiFile(req.params.projectId as string, req.params.fileId as string);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      try {
        // The slot stays held until this read settles, even if the client leaves.
        const bytes = await getFileStore().getBytes(file.storage_key);
        if (signal.aborted) return;
        if (!bytes) {
          res.status(404).json({ error: 'File contents are missing' });
          return;
        }
        const asciiName = file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
        res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Hold the slot until the bytes have been handed to the socket.
        await new Promise<void>((resolve) => {
          res.once('close', resolve);
          res.send(bytes);
        });
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
      }
    }),
  );

  router.patch('/api/projects/:projectId/wiki-files/:fileId', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const parsed = parseBody(MoveWikiFileRequestSchema, req, res);
    if (!parsed) return;
    if (!getWikiFile(projectId, req.params.fileId as string)) {
      return res.status(404).json({ error: 'File not found' });
    }
    try {
      const { file, pageSlug } = moveWikiFile(
        projectId,
        req.params.fileId as string,
        parsed.folder,
        resolveOwnerUserId(req as AuthenticatedRequest),
      );
      if (pageSlug) broadcast({ type: 'wiki_update', projectId, page: { slug: pageSlug } });
      broadcast({ type: 'wiki_files_update', projectId });
      res.json(file);
    } catch (err) {
      if (err instanceof WikiFileInputError) {
        const status = err.message.includes('already exists') ? 409 : 400;
        return res.status(status).json({ error: err.message });
      }
      throw err;
    }
  });

  router.delete(
    '/api/projects/:projectId/wiki-files/:fileId',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const result = await deleteWikiFile(projectId, getFileStore(), req.params.fileId as string);
      if (!result.deleted) return res.status(404).json({ error: 'File not found' });
      if (result.pageSlug) broadcast({ type: 'wiki_delete', projectId, slug: result.pageSlug });
      broadcast({ type: 'wiki_files_update', projectId });
      res.json({ ok: true });
    },
  );

  router.get('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const page = getPage(req.params.projectId as string, req.params.slug as string);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    // Clients render file-generated pages read-only.
    res.json({ ...page, source_file: getPageSourceFile(page.id) });
  });

  router.post('/api/projects/:projectId/wiki', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseBody(CreateWikiPageRequestSchema, req, res);
    if (!parsed) return;

    try {
      const page = createPage(projectId, {
        title: parsed.title,
        content: parsed.content,
        category: parsed.category,
        updatedBy: parsed.updatedBy,
      });
      stampLinkedCardDocumented(req, projectId);
      broadcast({ type: 'wiki_update', projectId, page });
      res.status(201).json(page);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const parsed = parseBody(UpdateWikiPageRequestSchema, req, res);
    if (!parsed) return;

    try {
      const page = updatePage(req.params.projectId as string, req.params.slug as string, {
        title: parsed.title,
        content: parsed.content,
        category: parsed.category,
        updatedBy: parsed.updatedBy,
      });
      stampLinkedCardDocumented(req, req.params.projectId as string);
      broadcast({ type: 'wiki_update', projectId: req.params.projectId, page });
      res.json(page);
    } catch (err) {
      if (err instanceof FileBackedPageError) {
        return res
          .status(409)
          .json({ error: err.message, code: 'file_backed_page', source_file: err.sourceFile });
      }
      if ((err as Error).message.includes('not found'))
        return res.status(404).json({ error: (err as Error).message });
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const deleted = deletePage(req.params.projectId as string, req.params.slug as string);
    if (!deleted) return res.status(404).json({ error: 'Page not found' });
    broadcast({ type: 'wiki_delete', projectId: req.params.projectId, slug: req.params.slug });
    res.json({ ok: true });
  });

  return router;
}

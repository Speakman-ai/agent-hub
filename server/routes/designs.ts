/**
 * Designs REST routes. CRUD + message history for hub-level Claude-Design
 * canvases. Chat itself flows over WebSocket (`design_chat` / `design_cancel`
 * in server/websocket.ts → design-chat.ts); this router only covers the
 * data-plane surface that the web client needs to list, create, rename,
 * link, or delete designs.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, DesignWithProjects } from '../types.js';
import {
  createDesign,
  listDesigns,
  getDesign,
  renameDesign,
  setLinkedProjects,
  deleteDesign,
  listDesignMessages,
  listDesignFilesRecursive,
  patchDesignChatEngineModelSession,
} from '../designs-store.js';
import { resolveEffectiveModel } from '../effective-model.js';
import {
  DESIGN_CHAT_ENGINES,
  isDesignChatEngine,
  normalizeDesignEngine,
} from '../design-multi-engine.js';
import { getDesignStatus } from '../design-chat.js';
import { getActiveOrgId } from '../orgs.js';
import { setSessionOwner, resolveOwnerUserId } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';

interface DesignRouteDeps extends RouteDeps {
  /** Absolute path of `<dataDir>/designs/`. Injected by index.ts. */
  getDesignsRoot: () => string;
}

const MAX_FORWARD_PROMPT_LENGTH = 50_000;
const MAX_FORWARD_CONTENT_BYTES = 512_000;
const MAX_FORWARD_DESIGN_MESSAGES = 120;
const MAX_FORWARD_MESSAGE_CHARS = 2_500;
const MAX_FORWARD_TEXT_FILES = 12;
const MAX_FORWARD_FILE_CHARS = 20_000;

const DESIGN_TEXT_FILE_RE = /\.(html?|css|js|jsx|ts|tsx|json|md|txt|svg)$/i;

function truncateChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function languageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.json') return 'json';
  if (ext === '.md') return 'markdown';
  if (ext === '.svg') return 'xml';
  return 'text';
}

/** After path.resolve, ensure `resolvedFile` is the same as or under `resolvedRoot` (no `..` escape). */
function isPathStrictlyInsideRoot(resolvedFile: string, resolvedRoot: string): boolean {
  const rootNorm = path.resolve(resolvedRoot);
  const fileNorm = path.resolve(resolvedFile);
  if (fileNorm === rootNorm) return false;
  const rel = path.relative(rootNorm, fileNorm);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export default function createDesignRoutes(deps: DesignRouteDeps): Router {
  const { findProject, broadcast, getDesignsRoot, config, stmts, findAgent, handleChat } = deps;
  const router = Router();

  function lookup(projectId: string) {
    return findProject(projectId);
  }

  router.get('/api/designs', (_req: Request, res: Response) => {
    res.json(listDesigns(lookup, getActiveOrgId()));
  });

  router.post('/api/designs', (req: Request, res: Response) => {
    const { name, linkedProjectIds } = req.body as {
      name?: string;
      linkedProjectIds?: string[];
    };
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const ids = Array.isArray(linkedProjectIds)
      ? linkedProjectIds.filter((x) => typeof x === 'string')
      : [];
    try {
      const design = createDesign(name, ids, getDesignsRoot(), lookup, getActiveOrgId());
      broadcast({ type: 'design_created', design });
      res.status(201).json(design);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.get('/api/designs/:id', (req: Request, res: Response) => {
    const design: DesignWithProjects | null = getDesign(
      req.params.id as string,
      lookup,
      getActiveOrgId(),
    );
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(design);
  });

  router.patch('/api/designs/:id', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });

    const body = req.body as {
      name?: string;
      linkedProjectIds?: string[];
      agentEngine?: string | null;
      agentModel?: string | null;
    };
    const { name, linkedProjectIds, agentEngine, agentModel } = body;
    const rawBody = req.body as Record<string, unknown>;

    let nextEngine: string | null = design.agent_engine ?? null;
    let nextModel: string | null = design.agent_model ?? null;
    let nextSession: string | null = design.engine_session_id ?? null;

    if ('agentEngine' in rawBody) {
      const raw = agentEngine;
      if (raw === null || raw === undefined) {
        nextEngine = null;
      } else if (typeof raw === 'string' && !raw.trim()) {
        nextEngine = null;
      } else if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'agentEngine must be a string or null' });
      } else {
        const trimmed = raw.trim();
        if (!isDesignChatEngine(trimmed)) {
          return res.status(400).json({
            error: `Invalid agentEngine. Allowed: ${DESIGN_CHAT_ENGINES.join(', ')}`,
          });
        }
        nextEngine = trimmed;
      }
      nextSession = null;
      if (!('agentModel' in rawBody)) {
        nextModel = null;
      }
    }

    if ('agentModel' in rawBody) {
      const raw = agentModel;
      const prevModelTrim = (design.agent_model || '').trim();
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'string') {
          return res.status(400).json({ error: 'agentModel must be a string or null' });
        }
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          const all = config.allValidModels;
          if (!all.includes(trimmed)) {
            return res.status(400).json({
              error: `Invalid model. Must be one of: ${all.join(', ')}`,
            });
          }
          const effEngine = normalizeDesignEngine(nextEngine);
          const allowed = config.engineValidModels[effEngine] || [];
          if (allowed.length > 0 && !allowed.includes(trimmed)) {
            return res.status(400).json({
              error: `Model "${trimmed}" is not valid for Design Studio (${effEngine}). Allowed: ${allowed.join(', ')}`,
            });
          }
          nextModel = trimmed;
        } else {
          nextModel = null;
        }
      } else {
        nextModel = null;
      }
      const nextModelTrim = (nextModel || '').trim();
      if (prevModelTrim !== nextModelTrim) {
        nextSession = null;
      }
    }

    try {
      if (typeof name === 'string' && name.trim()) {
        renameDesign(design.id, name);
      }
      if (Array.isArray(linkedProjectIds)) {
        setLinkedProjects(
          design.id,
          linkedProjectIds.filter((x) => typeof x === 'string'),
        );
      }
      if ('agentEngine' in rawBody || 'agentModel' in rawBody) {
        patchDesignChatEngineModelSession(design.id, nextEngine, nextModel, nextSession);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: msg });
    }

    const updated = getDesign(design.id, lookup, getActiveOrgId());
    // Metadata-only — do not emit `design_updated` (that reloads the canvas iframe).
    if (updated) broadcast({ type: 'design_metadata_updated', design: updated });
    res.json(updated);
  });

  router.delete('/api/designs/:id', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    deleteDesign(design.id, getDesignsRoot());
    broadcast({ type: 'design_deleted', designId: design.id });
    res.json({ ok: true });
  });

  /**
   * Recursive listing of the design's artifact files. Lets regular (non-
   * Design-Studio) agents discover what a design has produced without
   * guessing paths or scraping the iframe — the URL-encoded output of each
   * entry can be fetched via the existing `/design-files/:id/<path>` mount.
   *
   * Shape:
   *   { files: [{ path: "index.html", size: 1234, mtime: "..." }, ...] }
   *
   * org-scoped through `getDesign()` so cross-org reads 404.
   */
  router.get('/api/designs/:id/files', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    const files = listDesignFilesRecursive(getDesignsRoot(), design.id);
    res.json({ designId: design.id, files });
  });

  router.get('/api/designs/:id/messages', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(listDesignMessages(design.id));
  });

  /**
   * Status probe — answers "is a CLI turn currently running for this design,
   * and if so, what's the latest partial output?". The client calls this on
   * view re-entry to restore the thinking/streaming indicators (closing the
   * gap between navigation and the next WS broadcast) and to replay whatever
   * text has already been produced so the user isn't staring at a blank
   * spinner.
   */
  router.get('/api/designs/:id/status', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(getDesignStatus(design.id));
  });

  interface ForwardDesignBody {
    targetAgentId: string;
    prompt?: string;
    autoStart?: boolean;
    includeMessages?: boolean;
    includeFiles?: boolean;
    messageCount?: number;
  }

  router.post('/api/designs/:id/forward', (req: Request, res: Response) => {
    try {
      const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
      if (!design) return res.status(404).json({ error: 'Design not found' });

      const {
        targetAgentId,
        prompt,
        autoStart,
        includeMessages = true,
        includeFiles = true,
        messageCount,
      } = req.body as ForwardDesignBody;

      if (!targetAgentId || !targetAgentId.trim()) {
        return res.status(400).json({ error: 'targetAgentId is required' });
      }
      if (prompt && prompt.length > MAX_FORWARD_PROMPT_LENGTH) {
        return res.status(400).json({
          error: `prompt exceeds maximum length of ${MAX_FORWARD_PROMPT_LENGTH} characters`,
        });
      }
      if (autoStart && !handleChat) {
        return res.status(503).json({
          error: 'Auto-start is not available — chat handler is not initialized',
        });
      }

      const targetFound = findAgent(targetAgentId);
      if (!targetFound) {
        return res.status(404).json({ error: `Target agent not found: ${targetAgentId}` });
      }
      const targetAgent = targetFound.agent;

      const parts: string[] = [];
      if (prompt?.trim()) {
        parts.push(prompt.trim());
        parts.push('');
      }

      parts.push(`--- Forwarded Design Context: ${design.name} (${design.id}) ---`);
      if (design.linkedProjects?.length) {
        parts.push(
          `Linked projects: ${design.linkedProjects.map((p) => `${p.name} (${p.id})`).join(', ')}`,
        );
      }
      parts.push('');

      let forwardedMessageCount = 0;
      if (includeMessages) {
        const allMsgs = listDesignMessages(design.id);
        if (allMsgs.length > 0) {
          const requestedCount =
            typeof messageCount === 'number' && Number.isFinite(messageCount)
              ? Math.trunc(messageCount)
              : 40;
          const finalCount = Math.max(1, Math.min(MAX_FORWARD_DESIGN_MESSAGES, requestedCount));
          const selected = allMsgs.slice(-finalCount);
          forwardedMessageCount = selected.length;

          parts.push(`## Design Chat Transcript (last ${selected.length} messages)`);
          parts.push('');
          for (const m of selected) {
            const role =
              m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
            parts.push(`[${role}]`);
            parts.push(truncateChars(m.content || '', MAX_FORWARD_MESSAGE_CHARS));
            parts.push('');
          }
        }
      }

      let forwardedFileCount = 0;
      if (includeFiles) {
        const files = listDesignFilesRecursive(getDesignsRoot(), design.id)
          .map((f) => f.path)
          .sort((a, b) => a.localeCompare(b));

        if (files.length > 0) {
          parts.push('## Design Files');
          for (const file of files) {
            parts.push(`- ${file}`);
          }
          parts.push('');
        }

        const textFiles = files
          .filter((f) => DESIGN_TEXT_FILE_RE.test(f))
          .slice(0, MAX_FORWARD_TEXT_FILES);
        if (textFiles.length > 0) {
          parts.push('## Design File Contents');
          parts.push('');
          let designRootReal: string;
          try {
            designRootReal = realpathSync(path.join(getDesignsRoot(), design.id));
          } catch {
            designRootReal = path.join(getDesignsRoot(), design.id);
          }
          for (const relPath of textFiles) {
            const absCandidate = path.resolve(designRootReal, relPath);
            if (!isPathStrictlyInsideRoot(absCandidate, designRootReal)) {
              continue;
            }
            let absResolved: string;
            try {
              absResolved = realpathSync(absCandidate);
            } catch {
              continue;
            }
            if (!isPathStrictlyInsideRoot(absResolved, designRootReal)) {
              continue;
            }
            try {
              const raw = readFileSync(absResolved, 'utf-8');
              const clipped = truncateChars(raw, MAX_FORWARD_FILE_CHARS);
              parts.push(`### ${relPath}`);
              parts.push('```' + languageFromPath(relPath));
              parts.push(clipped);
              parts.push('```');
              parts.push('');
              forwardedFileCount++;
            } catch {
              // best effort; skip unreadable files
            }
          }
        }
      }

      parts.push('--- End of forwarded design context ---');
      const forwardedContent = parts.join('\n');
      const contentBytes = Buffer.byteLength(forwardedContent, 'utf8');
      if (contentBytes > MAX_FORWARD_CONTENT_BYTES) {
        return res.status(400).json({
          error: `Forwarded design context is too large (${contentBytes} bytes, max ${MAX_FORWARD_CONTENT_BYTES} bytes). Reduce messageCount or disable includeFiles/includeMessages.`,
        });
      }

      const newSessionId = uuidv4();
      const sessionName = `[Design Fwd] ${design.name}`.slice(0, 100);
      const fwdUid = resolveOwnerUserId(req as AuthenticatedRequest);
      const engine = targetAgent.engine || 'claude-code';
      const model = resolveEffectiveModel(config, engine, {
        agentModel: targetAgent.model,
        ownerUserId: fwdUid,
      });
      stmts.createSession.run(newSessionId, targetAgentId, sessionName, engine, model, 1, 0, 1);
      setSessionOwner(newSessionId, resolveOwnerUserId(req as AuthenticatedRequest));

      let forwardedMessageId: string | null = null;
      if (!autoStart) {
        forwardedMessageId = uuidv4();
        stmts.addMessage.run(
          forwardedMessageId,
          newSessionId,
          'user',
          forwardedContent,
          null,
          null,
          null,
          null,
        );
        stmts.touchSession.run(newSessionId);
      }

      const newSession = stmts.getSession.get(newSessionId);
      broadcast({
        type: 'session_forwarded',
        sourceType: 'design',
        sourceDesignId: design.id,
        targetAgentId,
        session: newSession,
        forwardedMessageId,
      });

      if (autoStart && handleChat) {
        handleChat(null, {
          type: 'chat',
          agentId: targetAgentId,
          sessionId: newSessionId,
          content: forwardedContent,
        });
      }

      return res.status(201).json({
        session: newSession,
        forwardedMessageId,
        included: {
          messages: forwardedMessageCount,
          files: forwardedFileCount,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  return router;
}

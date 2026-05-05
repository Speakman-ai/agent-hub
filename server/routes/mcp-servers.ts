/**
 * REST surface for the per-user MCP-server registry.
 *
 * All routes are authenticated and scope to `req.authUserId` — a user only
 * sees / mutates their own MCP servers. There is no admin override path:
 * MCP servers carry per-user credentials (API keys, bearer tokens) and an
 * admin reading them would be a privilege violation.
 *
 * Endpoints:
 *   GET    /api/mcp-servers           list (masked)
 *   POST   /api/mcp-servers           create
 *   PUT    /api/mcp-servers/:id       update (partial; MASK preserves)
 *   DELETE /api/mcp-servers/:id       delete
 *   GET    /api/mcp-catalog           well-known catalog templates
 */

import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServersMaskedForUser,
  readMcpServerRow,
  updateMcpServer,
  type McpTransport,
} from '../mcp-servers-store.js';
import { MCP_CATALOG } from '../mcp-catalog.js';

function bad(res: Response, code: number, message: string): void {
  res.status(code).json({ error: message });
}

function isPlainStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function parseTransport(v: unknown): McpTransport | null {
  return v === 'stdio' || v === 'http' ? v : null;
}

export default function createMcpServerRoutes(): Router {
  const router = Router();

  router.get('/api/mcp-catalog', (_req: Request, res: Response) => {
    res.json({ entries: MCP_CATALOG });
  });

  router.get('/api/mcp-servers', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const rows = listMcpServersMaskedForUser(authedReq.authUserId);
    res.json({ servers: rows });
  });

  router.post('/api/mcp-servers', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      bad(res, 400, 'name is required');
      return;
    }
    const transport = parseTransport(body.transport);
    if (!transport) {
      bad(res, 400, 'transport must be "stdio" or "http"');
      return;
    }
    const catalogIdRaw = body.catalogId;
    const catalogId =
      catalogIdRaw === null || catalogIdRaw === undefined
        ? null
        : typeof catalogIdRaw === 'string'
          ? catalogIdRaw
          : null;

    const command = typeof body.command === 'string' ? body.command : '';
    const url = typeof body.url === 'string' ? body.url : '';
    const args = isStringArray(body.args) ? body.args : [];
    const env = isPlainStringMap(body.env) ? body.env : {};
    const headers = isPlainStringMap(body.headers) ? body.headers : {};
    const enabled = body.enabled === false ? false : true;

    if (transport === 'stdio' && !command.trim()) {
      bad(res, 400, 'stdio transport requires a command');
      return;
    }
    if (transport === 'http' && !url.trim()) {
      bad(res, 400, 'http transport requires a url');
      return;
    }

    try {
      const created = createMcpServer({
        userId: authedReq.authUserId,
        name,
        catalogId,
        transport,
        command,
        args,
        url,
        env,
        headers,
        enabled,
      });
      res.status(201).json({ server: created });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bad(res, 400, message);
    }
  });

  router.put('/api/mcp-servers/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const id = String(req.params.id ?? '');
    const existing = readMcpServerRow(id);
    if (!existing) {
      // 404 (not 403) so foreign IDs don't leak existence — matches the
      // session-ownership convention.
      bad(res, 404, 'MCP server not found');
      return;
    }
    if (existing.userId !== authedReq.authUserId) {
      bad(res, 404, 'MCP server not found');
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateMcpServer>[1] = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (body.catalogId === null || typeof body.catalogId === 'string') {
      patch.catalogId = body.catalogId as string | null;
    }
    if (body.transport !== undefined) {
      const t = parseTransport(body.transport);
      if (!t) {
        bad(res, 400, 'transport must be "stdio" or "http"');
        return;
      }
      patch.transport = t;
    }
    if (typeof body.command === 'string') patch.command = body.command;
    if (typeof body.url === 'string') patch.url = body.url;
    if (isStringArray(body.args)) patch.args = body.args;
    if (isPlainStringMap(body.env)) patch.env = body.env;
    if (isPlainStringMap(body.headers)) patch.headers = body.headers;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

    try {
      const updated = updateMcpServer(id, patch);
      if (!updated) {
        bad(res, 404, 'MCP server not found');
        return;
      }
      res.json({ server: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bad(res, 400, message);
    }
  });

  router.delete('/api/mcp-servers/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      bad(res, 401, 'Authentication required');
      return;
    }
    const id = String(req.params.id ?? '');
    const existing = readMcpServerRow(id);
    if (!existing || existing.userId !== authedReq.authUserId) {
      bad(res, 404, 'MCP server not found');
      return;
    }
    deleteMcpServer(id);
    res.json({ ok: true });
  });

  return router;
}

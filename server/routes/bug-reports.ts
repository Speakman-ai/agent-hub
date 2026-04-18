import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { RouteDeps, ChatMessage, Agent } from '../types.js';

/**
 * Public, rate-limited bug-report intake endpoint.
 *
 * Accepts multipart/form-data from any Agent Hub client (web, electron, mobile).
 * Saves an optional screenshot to `server/uploads/`, then spawns a session for the
 * built-in `agent-hub-intake` agent to create a kanban card under the
 * `user-request` epic.
 *
 * The endpoint is intentionally unauthenticated (it's a cross-hub feedback
 * surface), so we gate it with an in-memory per-IP rate limiter: max
 * `RATE_LIMIT_MAX` reports per `RATE_LIMIT_WINDOW_MS`.
 */

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 6 * 1024 * 1024; // small buffer over the screenshot cap
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_CLIENT_TYPES = new Set(['web', 'electron', 'mobile']);
const INTAKE_PROJECT_ID = 'agent-hub';
const INTAKE_AGENT_ID = 'agent-hub-intake';

// ─── Rate limit ──────────────────────────────────────────────────
// Module-scoped so tests / the live server share the same window.
// Exported for test reset.
export const _rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function _resetRateLimit(): void {
  _rateBuckets.clear();
}

function ipFromReq(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimitCheck(ip: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = _rateBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    _rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count += 1;
  return { ok: true, retryAfterMs: 0 };
}

// ─── Multipart parser ────────────────────────────────────────────
// A minimal RFC 7578 parser — just enough for a small form with a single
// binary field (`screenshot`) plus short text fields. No dependency on
// multer since the rest of the app avoids it.

interface ParsedFile {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, ParsedFile>;
}

function parseMultipart(body: Buffer, boundary: string): ParsedMultipart {
  const fields: Record<string, string> = {};
  const files: Record<string, ParsedFile> = {};

  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = 0;
  while (start < body.length) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start !== 0) {
      // Strip trailing CRLF that precedes the boundary line
      const slice =
        body[idx - 2] === 0x0d && body[idx - 1] === 0x0a
          ? body.subarray(start, idx - 2)
          : body.subarray(start, idx);
      parts.push(slice);
    }
    start = idx + boundaryBuf.length;
    // Terminal boundary is "--boundary--"; bail out.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    // Skip CRLF after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);

    const disposition = headerStr.split('\r\n').find((l) => /^content-disposition:/i.test(l));
    if (!disposition) continue;
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);

    if (filenameMatch) {
      const ctLine = headerStr.split('\r\n').find((l) => /^content-type:/i.test(l));
      const contentType = ctLine
        ? ctLine.slice(ctLine.indexOf(':') + 1).trim()
        : 'application/octet-stream';
      files[name] = {
        name,
        filename: filenameMatch[1]!,
        contentType,
        data,
      };
    } else {
      fields[name] = data.toString('utf8');
    }
  }

  return { fields, files };
}

function getBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}

// ─── Prompt builder ──────────────────────────────────────────────

interface BugReportInput {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceUrl?: string;
  userAgent?: string;
  appVersion?: string;
  clientType?: string;
  currentProjectId?: string;
  currentAgentId?: string;
  screenshotUrl?: string | null;
}

export function buildBugReportPrompt(input: BugReportInput): string {
  const lines: string[] = [];
  lines.push('## Bug Report');
  lines.push('');
  lines.push(`**Title:** ${input.title}`);
  lines.push(`**Severity:** ${input.severity}`);
  lines.push('');
  lines.push('### Description');
  lines.push(input.description || '_(no description provided)_');
  lines.push('');
  lines.push('### Source Metadata');
  lines.push(`- **URL:** ${input.sourceUrl || '_unknown_'}`);
  lines.push(`- **User Agent:** ${input.userAgent || '_unknown_'}`);
  lines.push(`- **App Version:** ${input.appVersion || '_unknown_'}`);
  lines.push(`- **Client Type:** ${input.clientType || '_unknown_'}`);
  lines.push(`- **Current Project:** ${input.currentProjectId || '_unknown_'}`);
  lines.push(`- **Current Agent:** ${input.currentAgentId || '_unknown_'}`);
  if (input.screenshotUrl) {
    lines.push('');
    lines.push('### Screenshot');
    lines.push(`![bug report screenshot](${input.screenshotUrl})`);
  }
  lines.push('');
  lines.push(
    'Create a kanban card in the Backlog column of the agent-hub project under the `user-request` epic (create the epic if missing, color `#EF4444`). Link the card to that epic. Map severity→priority (critical→urgent, high→high, medium→medium, low→low). End the session after the card is created.',
  );
  lines.push('');
  lines.push(
    '**IMPORTANT:** Do NOT pass `session_id` (or `sessionId`) when creating this card. Your session is ephemeral and will exit immediately after creation — a stamped `session_id` will permanently mark the card as "assigned" and hide the Assignee dropdown from the user. Leave `session_id` and `assignee` unset so the user can assign the card to a real agent.',
  );
  return lines.join('\n');
}

// ─── Route factory ───────────────────────────────────────────────

export default function createBugReportRoutes(deps: RouteDeps): Router {
  const { stmts, findAgent, handleChat, serverDir } = deps;
  const router = Router();
  const UPLOADS_DIR = path.join(serverDir, 'uploads');
  mkdirSync(UPLOADS_DIR, { recursive: true });

  function applyCors(_req: Request, res: Response, next: NextFunction): void {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Requested-With');
    res.header('Access-Control-Max-Age', '600');
    next();
  }

  router.options('/api/bug-reports', applyCors, (_req, res) => {
    res.status(204).end();
  });

  router.post(
    '/api/bug-reports',
    applyCors,
    express.raw({
      type: (req) => /^multipart\/form-data/i.test(req.headers['content-type'] || ''),
      limit: MAX_MULTIPART_BYTES,
    }),
    (req: Request, res: Response) => {
      try {
        // ── Rate limit ─────────────────────────────────────
        const ip = ipFromReq(req);
        const rl = rateLimitCheck(ip);
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
          return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
        }

        // ── Content-type ───────────────────────────────────
        const contentType = req.headers['content-type'] || '';
        if (!/^multipart\/form-data/i.test(contentType)) {
          return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
        }
        const boundary = getBoundary(contentType);
        if (!boundary) {
          return res.status(400).json({ error: 'multipart/form-data boundary missing' });
        }

        const rawBody = req.body as Buffer;
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          return res.status(400).json({ error: 'Empty request body' });
        }

        const { fields, files } = parseMultipart(rawBody, boundary);

        // ── Validate fields ────────────────────────────────
        const title = (fields.title || '').trim();
        if (!title) {
          return res.status(400).json({ error: 'title is required' });
        }
        if (title.length > 200) {
          return res.status(400).json({ error: 'title must be 1–200 characters' });
        }

        const severityRaw = (fields.severity || 'medium').trim().toLowerCase();
        if (!VALID_SEVERITIES.has(severityRaw)) {
          return res.status(400).json({
            error: `severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
          });
        }
        const severity = severityRaw as BugReportInput['severity'];

        const clientTypeRaw = (fields.clientType || '').trim().toLowerCase();
        if (clientTypeRaw && !VALID_CLIENT_TYPES.has(clientTypeRaw)) {
          return res.status(400).json({
            error: `clientType must be one of: ${[...VALID_CLIENT_TYPES].join(', ')}`,
          });
        }

        const description = (fields.description || '').toString();
        const sourceUrl = (fields.sourceUrl || '').toString();
        const userAgent = (fields.userAgent || '').toString();
        const appVersion = (fields.appVersion || '').toString();
        const currentProjectId = (fields.currentProjectId || '').toString();
        const currentAgentId = (fields.currentAgentId || '').toString();

        // ── Save screenshot (optional) ─────────────────────
        let screenshotUrl: string | null = null;
        const screenshot = files.screenshot;
        if (screenshot) {
          if (!ALLOWED_IMAGE_TYPES.has(screenshot.contentType)) {
            return res.status(400).json({
              error: `screenshot must be image/png or image/jpeg (got ${screenshot.contentType})`,
            });
          }
          if (screenshot.data.length > MAX_SCREENSHOT_BYTES) {
            return res.status(413).json({ error: 'screenshot exceeds 5 MB limit' });
          }
          const ext = screenshot.contentType === 'image/png' ? 'png' : 'jpg';
          const filename = `${uuidv4()}.${ext}`;
          const dest = path.join(UPLOADS_DIR, filename);
          writeFileSync(dest, screenshot.data);
          screenshotUrl = `/uploads/${filename}`;
        }

        // ── Verify intake agent exists ─────────────────────
        const lookup = findAgent(INTAKE_AGENT_ID);
        if (!lookup) {
          console.error(
            `[Bug Reports] Intake agent ${INTAKE_AGENT_ID} not found — cannot dispatch`,
          );
          return res.status(500).json({
            error: `Intake agent ${INTAKE_AGENT_ID} is not configured on this server`,
          });
        }
        const agent: Agent = lookup.agent;

        // ── Build prompt ───────────────────────────────────
        const prompt = buildBugReportPrompt({
          title,
          description,
          severity,
          sourceUrl,
          userAgent,
          appVersion,
          clientType: clientTypeRaw,
          currentProjectId,
          currentAgentId,
          screenshotUrl,
        });

        // ── Spawn session ──────────────────────────────────
        const sessionId = uuidv4();
        const engine = (agent.engine as string) || 'claude-code';
        const model = (agent.model as string) || deps.DEFAULT_MODEL;
        const sessionName = `[Bug] ${title.substring(0, 80)}`;

        stmts.createSession.run(sessionId, INTAKE_AGENT_ID, sessionName, engine, model, 1, 0);

        const taskId = uuidv4();
        stmts.insertBackgroundTask.run(taskId, sessionId, INTAKE_AGENT_ID, prompt);

        const chatMsg: ChatMessage = {
          type: 'chat',
          agentId: INTAKE_AGENT_ID,
          sessionId,
          content: prompt,
        };
        setImmediate(() => {
          try {
            const result = handleChat(null, chatMsg);
            if (result && typeof (result as Promise<unknown>).catch === 'function') {
              (result as Promise<unknown>).catch((err: Error) => {
                console.error(
                  `[Bug Reports] handleChat failed for session ${sessionId}:`,
                  err.message,
                );
              });
            }
          } catch (err) {
            console.error(
              `[Bug Reports] handleChat threw for session ${sessionId}:`,
              (err as Error).message,
            );
          }
        });

        return res.status(202).json({ sessionId, status: 'dispatched' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Bug Reports] Unexpected failure:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  return router;
}

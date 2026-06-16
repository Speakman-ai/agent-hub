import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import type { RouteDeps, SupportTicketSeverity } from '../types.js';
import { intakeSupportTicket } from '../support-ticket-intake.js';
import {
  persistSupportTicketScreenshotBuffer,
  deleteSupportTicketScreenshot,
} from '../support-ticket-screenshot.js';

/**
 * Public, rate-limited bug-report intake endpoint.
 *
 * Accepts multipart/form-data from any Agent Hub client (web, electron, mobile)
 * and lands a `bug` support ticket in the hub's own (`agent-hub`) Customer
 * Support queue — the same persistent queue, severity ordering, and one-shot AI
 * investigation that `POST /api/projects/:projectId/support-tickets` produces.
 * The operator triages from the queue and promotes a ticket to a kanban card
 * with the existing "Convert to card" action.
 *
 * Visual context comes from an attached session replay (rrweb) when the reporter
 * has the recorder, and/or a `screenshot` image part: the screenshot is persisted
 * under `/uploads` and stored as the ticket's `screenshot_ref` so the Customer
 * Support queue renders it inline (the same column the authenticated support-ticket
 * route fills). A reporter widget that can only grab a screenshot (no rrweb) still
 * gets its photo through.
 *
 * The endpoint is intentionally unauthenticated (it's a cross-hub feedback
 * surface), so we gate it with an in-memory per-IP rate limiter: max
 * `RATE_LIMIT_MAX` reports per `RATE_LIMIT_WINDOW_MS`.
 */

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Fit an 8 MB screenshot (MAX_SCREENSHOT_BYTES, sent as raw multipart bytes —
// not base64) plus the short text fields, with headroom.
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024;
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_CLIENT_TYPES = new Set(['web', 'electron', 'mobile']);
const INTAKE_PROJECT_ID = 'agent-hub';

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
  replayRef?: string | null;
}

/**
 * Accept only a locally-resolvable session-replay ref produced by the
 * `/api/replays` ingest endpoint (`/uploads/replay-<id>.json`). Anything else
 * (remote URLs, traversal, other upload kinds) is dropped — the value flows
 * untrusted into the ticket body and, downstream, into `replay_ref`, so we keep
 * it to the exact shape `resolveReplayContext` is willing to read.
 */
export function sanitizeReplayRef(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ref = String(raw).trim();
  if (!/^\/uploads\/replay-[A-Za-z0-9._-]+\.json$/.test(ref)) return null;
  if (ref.includes('..')) return null;
  return ref;
}

/**
 * Build the support-ticket `body` for a bug report. The report's `title`
 * becomes the ticket `subject` and `severity` its own column, so the body
 * carries the free-text description plus the reporter context (URL, user agent,
 * client, etc.) that `support_tickets` has no dedicated columns for. The whole
 * body is treated as untrusted input by the investigation step (it fences and
 * escapes it), so no sanitisation beyond shape is required here.
 */
export function buildBugReportTicketBody(input: BugReportInput): string {
  const lines: string[] = [];
  lines.push(input.description?.trim() || '_(no description provided)_');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Reporter Context');
  lines.push(`- **Source URL:** ${input.sourceUrl || '_unknown_'}`);
  lines.push(`- **User Agent:** ${input.userAgent || '_unknown_'}`);
  lines.push(`- **App Version:** ${input.appVersion || '_unknown_'}`);
  lines.push(`- **Client Type:** ${input.clientType || '_unknown_'}`);
  lines.push(`- **Reported From Project:** ${input.currentProjectId || '_unknown_'}`);
  lines.push(`- **Reported From Agent:** ${input.currentAgentId || '_unknown_'}`);
  if (input.replayRef) {
    lines.push(
      `- **Session Replay:** \`${input.replayRef}\` (trailing window of rrweb DOM events captured for this report)`,
    );
  }
  return lines.join('\n');
}

// ─── Route factory ───────────────────────────────────────────────

export default function createBugReportRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, findProject, config, serverDir } = deps;
  const router = Router();

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
    async (req: Request, res: Response) => {
      // Hoisted so the catch below can roll back an orphaned screenshot file.
      let screenshotRef: string | null = null;
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
        // Narrowed to the canonical support-ticket severity union after the
        // VALID_SEVERITIES runtime check above, so it satisfies both
        // `buildBugReportTicketBody` and `CreateSupportTicketInput` without a
        // cast at the intake call site.
        const severity: SupportTicketSeverity = severityRaw as SupportTicketSeverity;

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
        const replayRef = sanitizeReplayRef(fields.replayRef);

        // Persist an optional `screenshot` image part so the photo shows inline
        // in the Customer Support queue (stored as the ticket's
        // `screenshot_ref`). The bytes are validated by magic-byte signature —
        // the declared content-type is not trusted. A bad/oversize/non-image
        // part is dropped (logged) rather than failing the whole report: this is
        // an unauthenticated feedback surface and a usable bug report should
        // still land even when its attachment is junk.
        const screenshotFile = files.screenshot;
        if (screenshotFile && screenshotFile.data.length > 0) {
          try {
            screenshotRef = await persistSupportTicketScreenshotBuffer(
              serverDir,
              screenshotFile.data,
            );
          } catch (err) {
            console.warn('[Bug Reports] screenshot dropped:', (err as Error).message);
          }
        }

        // ── Resolve the intake (agent-hub) project ─────────
        const project = findProject(INTAKE_PROJECT_ID);
        if (!project) {
          console.error(
            `[Bug Reports] Intake project ${INTAKE_PROJECT_ID} not found — cannot file ticket`,
          );
          return res.status(500).json({
            error: `Intake project ${INTAKE_PROJECT_ID} is not configured on this server`,
          });
        }

        // ── Land a bug support ticket in the queue ─────────
        // Build the body WITHOUT the replay line first. The raw `replayRef`
        // is still untrusted here — `intakeSupportTicket` runs the project
        // attribution guard and clears `replay_ref` for a foreign/nonexistent
        // ref. Embedding the ref now would leak a rejected ref into the
        // operator-visible body (and the AI prompt) even after the column is
        // cleared, so we reflect only the PERSISTED ref into the body below.
        const bodyFields = {
          title,
          description,
          severity,
          sourceUrl,
          userAgent,
          appVersion,
          clientType: clientTypeRaw,
          currentProjectId,
          currentAgentId,
        };

        const ticket = await intakeSupportTicket(
          {
            projectId: project.id,
            type: 'bug',
            severity,
            subject: title,
            body: buildBugReportTicketBody({ ...bodyFields, replayRef: null }),
            reporter: clientTypeRaw ? `bug-report (${clientTypeRaw})` : 'bug-report',
            replayRef,
            screenshotRef,
          },
          {
            stmts,
            broadcast,
            config,
            serverDir,
            cwd: project.cwd,
            // Surface the replay ref in the body only once the guard has
            // accepted it for persistence (`ticket.replay_ref`). The helper
            // applies this before broadcast/investigation, so a rejected ref
            // never reaches the body and consumers see the finalized one.
            finalizeBody: (t) =>
              t.replay_ref
                ? buildBugReportTicketBody({ ...bodyFields, replayRef: t.replay_ref })
                : null,
          },
        );

        return res.status(201).json({ ticketId: ticket.id, status: 'received' });
      } catch (err) {
        // The ticket didn't land — remove a screenshot we may have written so it
        // isn't orphaned under /uploads.
        await deleteSupportTicketScreenshot(serverDir, screenshotRef);
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Bug Reports] Unexpected failure:', message);
        return res.status(500).json({ error: message });
      }
    },
  );

  return router;
}

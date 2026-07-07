import type { ErrorRequestHandler } from 'express';

/**
 * Global fallback for body-parser failures on any route the more specific
 * `publicCorsErrorHandler` did not already answer.
 *
 * The global `express.json({ limit: '20mb' })` parser in index.ts runs before
 * any router, so a malformed or oversized body throws BEFORE the route is
 * reached. `publicCorsErrorHandler` maps that to a clean 400 / 413 (with CORS
 * headers) for the two public ingest paths, but every other route falls
 * through to Express's default `finalhandler`, which — even for a 4xx — writes
 * the full error stack to stderr. The canonical trigger is a caller that sends
 * `Content-Type: application/json` with a plain-text body (e.g. an agent
 * message "Implemented ..."): the client already gets a 400, but the stack
 * dump buries real errors in the logs.
 *
 * This handler catches the standard body-parser error shapes for ALL remaining
 * paths, answers with a concise JSON error, and logs a single warn line
 * instead of a stack trace. Non-body-parser errors are delegated unchanged.
 *
 * Mount AFTER `publicCorsErrorHandler` (it is error-handling middleware). The
 * public handler returns for its paths, so this never double-handles them.
 */
interface BodyParserError {
  type?: string;
  status?: number;
  statusCode?: number;
  message?: string;
}

// Error `type` values body-parser attaches to a request-body failure it wants
// surfaced as a 4xx: `entity.parse.failed` (400, malformed JSON) and
// `charset.unsupported` / `encoding.unsupported` (415, undecodable). Each error
// also carries the intended `status`, which the handler honors verbatim.
// `entity.too.large` (413) is checked separately.
const BODY_FAILURE_TYPES = new Set([
  'entity.parse.failed',
  'charset.unsupported',
  'encoding.unsupported',
]);

function isBodyParserError(err: unknown): err is BodyParserError {
  const e = err as BodyParserError | null;
  if (!e || typeof e !== 'object') return false;
  if (
    typeof e.type === 'string' &&
    (e.type === 'entity.too.large' || BODY_FAILURE_TYPES.has(e.type))
  ) {
    return true;
  }
  // Body-parser tags its JSON parse errors with `entity.parse.failed` (caught
  // above), but also attaches a `body` property. Match a bare SyntaxError only
  // when that marker is present so a genuine SyntaxError thrown by a downstream
  // route (e.g. an internal JSON.parse) is NOT masked as a 400 — it must fall
  // through to `next(err)` and surface as a 500.
  return err instanceof SyntaxError && 'body' in err;
}

export const jsonBodyErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent || !isBodyParserError(err)) {
    next(err);
    return;
  }

  const e = (err ?? {}) as BodyParserError;
  // Honor the status body-parser assigned (400 parse / 413 too-large /
  // 415 unsupported charset/encoding); default to 400 for a bare SyntaxError.
  const status = e.status ?? e.statusCode ?? 400;

  if (e.type === 'entity.too.large' || status === 413) {
    console.warn(`[json] rejected oversized body on ${req.method} ${req.path}`);
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  const message = status === 415 ? 'Unsupported media type' : 'Invalid request body';
  console.warn(
    `[json] rejected ${status} body on ${req.method} ${req.path}: ${e.message ?? 'invalid body'}`,
  );
  res.status(status).json({ error: message });
};

/**
 * Deterministic issue fingerprinting for repeated-error grouping (decision
 * LOG-GROUP). Given a normalized (and already LOG-TRUST-redacted) log record,
 * this derives the stable grouping key plus the human-facing facets an issue
 * group tracks.
 *
 * Eligibility (decision LOG-GROUP): only ERROR-or-higher records, or records
 * carrying structured OTel exception fields (`exception.type` /
 * `exception.message` / `exception.stacktrace`), are grouped. Everything else
 * returns `null` and never creates an issue.
 *
 * The fingerprint is built from — and ONLY from — the axes the spec locks:
 * project, source/service, environment, exception type, the normalized message
 * template, and the first in-app stack frames. Volatile bits (timestamps,
 * request/user IDs, hex/UUIDs, numbers, memory addresses) are scrubbed out of
 * the message template and stack frames so the same defect fingerprints
 * identically across occurrences. Release version and commit SHA are
 * deliberately EXCLUDED from the hash and kept as issue facets instead, so a
 * fixed-then-recurring bug reopens the same group rather than forking a new one
 * per release.
 *
 * Pure and IO-free — hashes inputs, touches no DB or clock — so the
 * normalization rules unit-test in isolation.
 */

import { createHash } from 'crypto';
import { ERROR_SEVERITY_FLOOR } from './logs-schema.js';

/** Attribute/resource keys carrying a release identifier, in priority order. */
const RELEASE_KEYS = ['service.version', 'deployment.release', 'release', 'app.version'];
/** Attribute/resource keys carrying a source-control commit SHA, in priority order. */
const COMMIT_KEYS = [
  'vcs.repository.ref.revision',
  'vcs.repository.change.id',
  'git.commit.sha',
  'commit.sha',
  'service.commit',
  'commit',
];

/** Stack frames from these locations are library/runtime, not in-app. */
const LIBRARY_FRAME_MARKERS = [
  'node_modules',
  'node:internal',
  '(internal/',
  'internal/process',
  'site-packages',
  'dist-packages',
  'lib/python',
  '/usr/lib/',
  '/usr/local/lib/',
];

/** How many in-app frames feed the fingerprint (and are exposed for debugging). */
export const MAX_FINGERPRINT_FRAMES = 5;
/** Upper bound on the stored message template / title length. */
export const MAX_TEMPLATE_LENGTH = 500;
export const MAX_TITLE_LENGTH = 200;

/** Inputs the derivation needs — all post-redaction so no secret feeds the hash. */
export interface FingerprintInput {
  projectId: string;
  sourceId: string;
  serviceName?: string | null;
  environment?: string | null;
  severityNumber?: number | null;
  /** Redacted body, already stringified. */
  body?: string | null;
  /** Redacted record attributes (OTel exception.* lives here). */
  attributes?: Record<string, unknown> | null;
  /** Redacted resource attributes (release / commit facets live here). */
  resource?: Record<string, unknown> | null;
}

/** The grouping key plus the facets an issue row stores. */
export interface IssueGrouping {
  /** Stable 128-bit hex grouping key. */
  fingerprint: string;
  /** source/service axis — service name when known, else the source id. */
  service: string | null;
  environment: string | null;
  exceptionType: string | null;
  /** Volatile-ID-scrubbed message template (the grouping message). */
  messageTemplate: string;
  /** Human title for the group (stable across occurrences). */
  title: string;
  /** Release facet — NOT part of the fingerprint. */
  release: string | null;
  /** Commit SHA facet — NOT part of the fingerprint. */
  commitSha: string | null;
  /** First in-app stack frames used in the hash (diagnostic). */
  frames: string[];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function firstStringFrom(
  sources: Array<Record<string, unknown> | null | undefined>,
  keys: string[],
): string | null {
  for (const key of keys) {
    for (const src of sources) {
      if (src && typeof src === 'object') {
        const hit = asString((src as Record<string, unknown>)[key]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/**
 * Scrub volatile identifiers out of a message so the same error text yields
 * the same template regardless of the concrete IDs it embeds. Order matters:
 * structured patterns (timestamps, UUIDs, URLs, IPs, hex) run before the
 * catch-all number rule so they aren't partially eaten first.
 */
export function normalizeMessageTemplate(message: string | null | undefined): string {
  if (!message) return '';
  let out = message;
  // ISO-8601 timestamps (before the number rule swallows the digits).
  out = out.replace(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi,
    '<ts>',
  );
  // UUIDs (before hex — a UUID is otherwise a run of hex).
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
  // Emails and URLs.
  out = out.replace(/[\w.+-]+@[a-z0-9-]+\.[a-z0-9.-]+/gi, '<email>');
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
  // IPv4 (before the number rule).
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>');
  // Hex literals (0x…) and long hashes (require at least one a-f so pure
  // decimals fall through to the number rule and become <n>, not <hex>).
  out = out.replace(/\b0x[0-9a-f]+\b/gi, '<hex>');
  out = out.replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>');
  // Any remaining bare number (ints, decimals, negatives).
  out = out.replace(/-?\b\d+(?:\.\d+)?\b/g, '<n>');
  // Collapse whitespace so wrapping/indentation differences don't fork groups.
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_TEMPLATE_LENGTH) out = out.slice(0, MAX_TEMPLATE_LENGTH);
  return out;
}

function isLibraryFrame(line: string): boolean {
  return LIBRARY_FRAME_MARKERS.some((m) => line.includes(m));
}

/** Strip line/column numbers and memory addresses from one stack-frame line. */
function normalizeFrame(line: string): string {
  return line
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/:\d+(:\d+)?/g, '')
    .replace(/, line \d+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Pull the first in-app stack frames out of an OTel `exception.stacktrace`
 * blob. Language-agnostic: recognizes V8 (`at fn (file:line:col)`), Python
 * (`File "…", line N, in fn`), and Java (`at pkg.Class.method(File.java:N)`)
 * frame lines. In-app frames (not in node_modules / stdlib) are preferred; if
 * every frame is library code we still keep the first few so the group is
 * stable rather than empty.
 */
export function extractInAppFrames(stacktrace: string | null | undefined): string[] {
  if (!stacktrace || typeof stacktrace !== 'string') return [];
  const frameLines = stacktrace
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^at\s/i.test(l) || /^file\s+"/i.test(l) || /:\d+(:\d+)?\)?$/.test(l));

  const inApp: string[] = [];
  const all: string[] = [];
  for (const line of frameLines) {
    const norm = normalizeFrame(line);
    if (!norm) continue;
    all.push(norm);
    if (!isLibraryFrame(line)) inApp.push(norm);
    if (inApp.length >= MAX_FINGERPRINT_FRAMES) break;
  }
  const chosen = inApp.length > 0 ? inApp : all;
  return chosen.slice(0, MAX_FINGERPRINT_FRAMES);
}

function buildTitle(exceptionType: string | null, template: string, frames: string[]): string {
  const head = template || frames[0] || 'Error';
  const title = exceptionType ? `${exceptionType}: ${head}` : head;
  return title.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Derive the issue grouping for a normalized record, or `null` when the record
 * is not group-eligible (below ERROR and no structured exception fields).
 */
export function deriveIssueGrouping(input: FingerprintInput): IssueGrouping | null {
  const attrs = input.attributes ?? null;
  const exceptionType = asString(attrs?.['exception.type']);
  const exceptionMessage = asString(attrs?.['exception.message']);
  const stacktrace = asString(attrs?.['exception.stacktrace']);
  const hasStructuredException = Boolean(exceptionType || exceptionMessage || stacktrace);
  const severity = typeof input.severityNumber === 'number' ? input.severityNumber : 0;

  if (severity < ERROR_SEVERITY_FLOOR && !hasStructuredException) return null;

  const service = asString(input.serviceName) ?? input.sourceId;
  const environment = asString(input.environment);
  const messageTemplate = normalizeMessageTemplate(exceptionMessage ?? input.body ?? '');
  const frames = extractInAppFrames(stacktrace);

  const hash = createHash('sha256');
  hash.update(
    [
      'v1',
      input.projectId,
      service,
      environment ?? '',
      exceptionType ?? '',
      messageTemplate,
      frames.join('\x1e'),
    ].join('\x1f'),
  );
  const fingerprint = hash.digest('hex').slice(0, 32);

  return {
    fingerprint,
    service,
    environment,
    exceptionType,
    messageTemplate,
    title: buildTitle(exceptionType, messageTemplate, frames),
    release: firstStringFrom([attrs, input.resource], RELEASE_KEYS),
    commitSha: firstStringFrom([attrs, input.resource], COMMIT_KEYS),
    frames,
  };
}

/**
 * Run kickoff for QA plans: which tool the QA agent drives the target with,
 * and the seed message that opens a run's QA session.
 *
 * The `browser` tool's egress policy refuses loopback and private targets.
 * The `preview` tool reaches them, but only by driving one session's preview,
 * and a run's QA session has none of its own. So `resolveQaTarget` is the one
 * place that decides: a public URL goes to `browser`; anything else goes to
 * `preview` only when it identifies exactly one project session whose preview
 * serves it, and is otherwise unreachable. Never guess: a wrong match would
 * test a different application and could record passing results for it.
 *
 * What counts as identifying a session:
 *   - a preview subdomain or this Hub's preview proxy path names it. A
 *     port-prefixed subdomain or `/p/<port>` sub-mount must name the port
 *     the preview tool drives (the session's primary endpoint);
 *   - a loopback alias (localhost, 127/8, ::1, 0.0.0.0) on the host port an
 *     active preview is bound to, since previews bind ports on the Hub host;
 *   - any other host only when its origin equals an active preview's URL origin.
 * Two or more sessions matching is ambiguous and refused.
 */
import { isLoopbackHost } from './loopback-host.js';
import { matchPreviewProxyPath } from './preview-auth.js';
import { parsePreviewSubdomainHost } from './preview/preview-subdomain-host.js';
import type { Project, QaCaseRow, QaPlanRow, QaRunRow, Stmts } from './types.js';

/** A running or starting preview, as the dev-server runtime lists it. */
export interface QaActivePreview {
  session_id: string;
  status: string;
  port: number;
  url: string;
}

export type QaTargetResolution =
  | { tool: 'browser'; reason: string }
  | {
      tool: 'preview';
      reason: string;
      previewSessionId: string;
      /**
       * Where the target lives inside that preview, as a `navigate` route:
       * path, query, and fragment (hash-routed apps keep their screen).
       */
      route: string;
    }
  | { tool: 'unreachable'; reason: string };

export interface QaTargetContext {
  previewSubdomainBase?: string | null;
  /** This Hub's public URL; its origin is the only one a proxy path counts on. */
  hubPublicUrl?: string | null;
  activePreviews?: readonly QaActivePreview[];
  /** Whether a session id is a live session of the plan's project. */
  isProjectSession: (sessionId: string) => boolean;
  /**
   * Internal port of the primary endpoint of the session's active preview,
   * or null when none is running. The preview tool only ever drives that
   * endpoint, so a target naming another port of the session is refused.
   */
  primaryInternalPort?: (sessionId: string) => number | null;
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '');
  if (!h.includes(':')) return false;
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

/** Hostnames that only resolve on a local network (`.local`, single-label, …). */
function isLocalName(host: string): boolean {
  if (host.includes(':')) return false;
  if (!host.includes('.')) return true;
  return /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);
}

function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
}

/** Proxy mount: optional `/p/<internalPort>` sub-mount, then the in-app path. */
const PREVIEW_PROXY_MOUNT_RE = /^\/api\/sessions\/[^/]+\/preview\/proxy(?:\/p\/(\d+))?(\/.*)?$/;

const isActive = (p: QaActivePreview) => p.status === 'ready' || p.status === 'starting';

/** Pick the tool, and for `preview` the session, for a plan's target URL. Pure. */
export function resolveQaTarget(targetUrl: string, ctx: QaTargetContext): QaTargetResolution {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { tool: 'browser', reason: 'the target is not a parseable URL' };
  }
  const host = url.hostname.toLowerCase();
  const unreachable = (why: string): QaTargetResolution => ({
    tool: 'unreachable',
    reason: `${targetUrl} ${why}. Start the preview of the session that hosts it, or target a public URL.`,
  });
  const tail = `${url.search}${url.hash}`;
  const appRoute = `${url.pathname || '/'}${tail}`;

  // Every preview match is an endpoint: a session plus the internal port the
  // target addresses (null = the primary endpoint). `accept` is the single
  // check that the endpoint is the one the preview tool will drive.
  const accept = (
    sessionId: string,
    internalPort: number | null,
    route: string,
    reason: string,
  ): QaTargetResolution => {
    if (!ctx.isProjectSession(sessionId)) {
      return unreachable('is a session preview outside this project');
    }
    if (internalPort !== null) {
      const primary = ctx.primaryInternalPort?.(sessionId) ?? null;
      if (primary === null) {
        return unreachable(
          `addresses port ${internalPort} of session ${sessionId}'s preview, which is not running, so the port cannot be checked`,
        );
      }
      if (primary !== internalPort) {
        return unreachable(
          `addresses port ${internalPort} of session ${sessionId}'s preview, but the preview tool drives its primary port ${primary}`,
        );
      }
    }
    return { tool: 'preview', reason, previewSessionId: sessionId, route };
  };
  const SESSION_PREVIEW = 'the target is an Agent Hub session preview';

  const sub = parsePreviewSubdomainHost(url.host, ctx.previewSubdomainBase);
  if (sub) return accept(sub.sessionId, sub.internalPort, appRoute, SESSION_PREVIEW);
  const hubOrigin = originOf(ctx.hubPublicUrl);
  if (hubOrigin !== null && url.origin === hubOrigin) {
    const proxied = matchPreviewProxyPath(url.pathname);
    if (proxied) {
      // `/preview/proxy/p/<internalPort>/…` addresses an extra port; the app
      // path is whatever follows the mount.
      const m = url.pathname.match(PREVIEW_PROXY_MOUNT_RE);
      const subPort = m?.[1] ? Number(m[1]) : null;
      if (subPort !== null && !(Number.isInteger(subPort) && subPort >= 1 && subPort <= 65535)) {
        return unreachable('names an invalid preview port');
      }
      const inApp = m?.[2] || '/';
      return accept(proxied, subPort, `${inApp}${tail}`, SESSION_PREVIEW);
    }
  }

  const loopback = isLoopbackHost(host);
  if (!loopback && !isPrivateIpv4(host) && !isPrivateIpv6(host) && !isLocalName(host)) {
    return { tool: 'browser', reason: 'the target is a public URL' };
  }

  // Active preview rows describe each session's primary endpoint (host port
  // and client URL), so a match here is already the endpoint the tool drives.
  const port = effectivePort(url);
  const sessions = new Set(
    (ctx.activePreviews ?? [])
      .filter(isActive)
      .filter((p) =>
        loopback
          ? (port !== '' && String(p.port) === port) || originOf(p.url) === url.origin
          : originOf(p.url) === url.origin,
      )
      .map((p) => p.session_id)
      .filter((id) => ctx.isProjectSession(id)),
  );
  if (sessions.size > 1) {
    return unreachable(`matches the previews of ${sessions.size} sessions, so it is ambiguous`);
  }
  const [only] = sessions;
  if (!only) return unreachable('is not served by any running session preview in this project');
  return accept(
    only,
    null,
    appRoute,
    loopback
      ? 'the target is a loopback host'
      : 'the target is a private-network host served by a session preview',
  );
}

function caseBlock(c: Pick<QaCaseRow, 'id' | 'title' | 'steps' | 'expected'>, n: number): string {
  return [
    `#### ${n}. ${c.title}`,
    '',
    `- **Case id:** \`${c.id}\``,
    `- **Steps:**`,
    '',
    c.steps.trim() || '_No steps written. Work them out from the title and say so in notes._',
    '',
    `- **Expected:** ${c.expected.trim() || '_Not written. Record what you observe._'}`,
  ].join('\n');
}

/** The first user turn of a run's QA session. Pure. */
export function buildQaRunSeed(args: {
  project: Pick<Project, 'id' | 'name'>;
  plan: Pick<QaPlanRow, 'id' | 'title' | 'goal' | 'target_url'>;
  run: Pick<QaRunRow, 'id' | 'iteration' | 'scope'>;
  /** In-scope cases, in run order. */
  cases: Array<Pick<QaCaseRow, 'id' | 'title' | 'steps' | 'expected'>>;
  routing: Exclude<QaTargetResolution, { tool: 'unreachable' }>;
}): string {
  const { project, plan, run, cases, routing } = args;
  const toolLine =
    routing.tool === 'preview'
      ? `Drive the target with the \`preview\` ReAct tool, because ${routing.reason}. The \`browser\` tool's egress policy refuses it. In this session the preview tool drives session \`${routing.previewSessionId}\`'s preview, which serves the target: use \`navigate\` with a route (the target is \`${routing.route}\`), never a full URL. You cannot start or stop that preview; if \`state\` says it is not running, mark the cases \`blocked\` and say the preview was down.`
      : `Drive the target with the \`browser\` ReAct tool, because ${routing.reason} (\`navigate\`, \`click\`, \`type\`, \`screenshot\`, \`read_page\`).`;
  const scopeLine =
    run.scope === 'failed_only'
      ? `Scope: **failed_only**. Only the ${cases.length} case(s) below did not pass on their current version last time; the others keep their earlier verdicts.`
      : `Scope: **full**. All ${cases.length} case(s) below.`;
  return [
    `[QA run #${run.iteration}] ${plan.title}`,
    '',
    `Execute run \`${run.id}\` (iteration ${run.iteration}) of approved QA plan \`${plan.id}\` in project \`${project.id}\`.`,
    '',
    `- **Target URL:** ${plan.target_url}`,
    `- **Goal:** ${plan.goal.trim() || '_None given._'}`,
    `- ${scopeLine}`,
    `- **Tool:** ${toolLine}`,
    '',
    '### Cases',
    '',
    cases.map((c, i) => caseBlock(c, i + 1)).join('\n\n'),
    '',
    '### What to do',
    '',
    '1. The run is already **running**; do not call `qa.sh run begin`.',
    '2. For each case, in order: follow the steps, take at least one screenshot, upload it with `artifacts.sh put`, then post the verdict before moving on:',
    `   \`qa.sh result post ${plan.id} ${run.id} --case <caseId> --verdict pass|fail|needs_change|blocked --actual "<what you saw>" --screenshot <artifactId>\``,
    '3. A case you could not reach or execute is `blocked`, never `pass`. Use skill credentials or an `agenthub:credential-request` card for logins, and the `approval` tool before any destructive action on the target.',
    '4. File finding cards for `fail` / `needs_change` results as the `agent-hub-qa` skill describes.',
    '5. The server finishes the run and derives passed / failed once every case above has a result. Finish with a short summary of the verdicts here.',
    '',
    'Do not edit code, commit, or touch the plan or its cases.',
  ].join('\n');
}

/**
 * The session whose preview a QA run session drives, or null when
 * `chatSessionId` is not a run session with a preview target.
 */
export function qaRunPreviewOwnerSessionId(
  stmts: Pick<Stmts, 'getQaRunPreviewSessionBySession'>,
  chatSessionId: string,
): string | null {
  try {
    return stmts.getQaRunPreviewSessionBySession.get(chatSessionId)?.preview_session_id ?? null;
  } catch {
    return null;
  }
}

/** Preview start refusal for a QA session driving another session's preview. */
export function qaBorrowedPreviewStartRefusal(ownerSessionId: string): {
  ok: false;
  error: string;
  statusCode: number;
} {
  return {
    ok: false,
    statusCode: 409,
    error: `This QA run drives session ${ownerSessionId}'s preview and cannot start it. Mark the cases blocked; a human starts that preview from its own session.`,
  };
}

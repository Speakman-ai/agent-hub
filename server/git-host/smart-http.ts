/**
 * smart-http.ts — git smart-HTTP transport for Agent Hub-hosted repos.
 *
 * Serves `git clone` / `fetch` / `push` for `gitHost: 'agenthub'`
 * projects at `/git/<projectId>.git` by spawning the real pack
 * processes (`git upload-pack` / `git receive-pack` with
 * `--stateless-rpc`) and piping the HTTP streams through them — the
 * node-git-server approach, no CGI `http-backend` and no third-party
 * wrapper.
 *
 * MOUNTING CONTRACT (server/index.ts): this router must be mounted
 * AFTER `cors` and BEFORE `express.json` — request bodies must reach the
 * spawned pack process unconsumed. `/git` is outside `/api`, so the main
 * `authMiddleware` never sees these requests; auth is self-contained in
 * `./auth.ts` (HTTP Basic, ahub_ API keys).
 *
 * Protocol notes (gitprotocol-http(5)):
 *   - `GET /info/refs?service=<svc>` responds with
 *     `application/x-<svc>-advertisement`, no-cache headers, a pkt-line
 *     `# service=<svc>` preamble + flush, then `--advertise-refs` output.
 *   - POST bodies may arrive gzip-encoded (git compresses bodies >~1KB);
 *     they are gunzipped before the child's stdin.
 *   - Responses are chunked streams — never set Content-Length.
 *   - The `Git-Protocol` request header is forwarded as `GIT_PROTOCOL`
 *     so protocol v2 negotiation works.
 *   - The dumb protocol is deliberately unsupported (404 for object
 *     paths); every git client since 1.6.6 speaks smart HTTP.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { spawn } from 'child_process';
import { createGunzip } from 'zlib';
import { timingSafeEqual } from 'crypto';
import config from '../config.js';
import type { Project } from '../types.js';
import { gitHostRepoPath, hostedRepoExists, readNotifyConfig } from './repo-store.js';
import { notifyMirrorPush } from './mirror.js';
import {
  authenticateGitRequest,
  canAccessHostedRepo,
  GIT_WWW_AUTHENTICATE,
  type GitCaller,
} from './auth.js';
import { recordPusher, releasePusher, takeRecentPusher } from './recent-pusher.js';

type GitService = 'git-upload-pack' | 'git-receive-pack';

const SERVICES: ReadonlySet<string> = new Set(['git-upload-pack', 'git-receive-pack']);

export interface GitSmartHttpDeps {
  findProject: (projectId: string) => Project | null;
  /** WS broadcast for push/mirror events (notify endpoint). */
  broadcast?: (data: Record<string, unknown>) => void;
  /**
   * "CI on push" hook fired by the notify endpoint when refs move —
   * wired to `maybeRunPushCi` in index.ts (needs stmts, so it cannot be
   * constructed here). Optional: tests and the mirror-only path omit it.
   *
   * `ctx.pushedByUserId` is the authenticated Hub user who ran the
   * `git-receive-pack` that triggered this notification (best-effort
   * correlation via `recent-pusher.ts`), or null for an anonymous /
   * break-glass push. Downstream uses it to run external-push auto-review
   * as the pushing user (their reviewer engine/model + credentials).
   */
  onPush?: (
    project: Project,
    updatedRefs: string[],
    ctx?: { pushedByUserId?: string | null; pushOptions?: string[] },
  ) => void;
  dataDir?: string;
}

/**
 * Resolve `:repo` (`<projectId>.git`) to a hosted project. Returns null
 * for unknown projects, projects not opted into agenthub hosting, or
 * missing bare repos — all collapse to 404 so the route leaks nothing
 * about which project ids exist.
 */
function resolveHostedProject(
  repoParam: string,
  deps: GitSmartHttpDeps,
): { project: Project; repoPath: string } | null {
  if (!repoParam.endsWith('.git')) return null;
  const projectId = repoParam.slice(0, -'.git'.length);
  let repoPath: string;
  try {
    repoPath = gitHostRepoPath(projectId, deps.dataDir ?? config.dataDir);
  } catch {
    return null; // invalid id shape
  }
  const project = deps.findProject(projectId);
  if (!project || project.gitHost !== 'agenthub') return null;
  if (!hostedRepoExists(projectId, deps.dataDir ?? config.dataDir)) return null;
  return { project, repoPath };
}

/** Auth + authz for one request; writes the failure response itself. */
async function gateRequest(
  req: Request,
  res: Response,
  project: Project,
  access: 'read' | 'write',
): Promise<GitCaller | null> {
  const auth = await authenticateGitRequest(req);
  if (!auth.ok) {
    if (auth.status === 401) res.set('WWW-Authenticate', GIT_WWW_AUTHENTICATE);
    res.status(auth.status).type('text/plain').send(auth.message);
    return null;
  }
  if (!canAccessHostedRepo(project, auth.caller, access)) {
    // 404, not 403 — same reasoning as resolveHostedProject: don't
    // confirm repo existence to callers who can't see the project.
    res.status(404).type('text/plain').send('Repository not found.');
    return null;
  }
  return auth.caller;
}

function noCacheHeaders(res: Response): void {
  res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.set('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  res.set('Pragma', 'no-cache');
}

function packEnv(req: Request): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const proto = req.headers['git-protocol'];
  if (typeof proto === 'string' && proto.length > 0 && proto.length < 256) {
    env.GIT_PROTOCOL = proto;
  }
  return env;
}

/** `git-upload-pack` → `upload-pack` (argv must not repeat the `git-`). */
function serviceArgv(service: GitService): string {
  return service.replace(/^git-/, '');
}

/**
 * `git -c <cfg>` prefix for a spawned service. Enables push-option
 * advertisement on receive-pack so a client's `git push -o <opt>` is accepted
 * and delivered to the post-receive hook as `GIT_PUSH_OPTION_*`. No-op (and
 * harmless) for upload-pack. Applied to BOTH the advertise and the RPC spawn —
 * the capability must appear in the ref advertisement for the client to send
 * options at all.
 */
function gitServiceConfigArgs(service: GitService): string[] {
  return service === 'git-receive-pack' ? ['-c', 'receive.advertisePushOptions=true'] : [];
}

/**
 * Parse the comma-joined `X-AgentHub-Push-Options` header the post-receive hook
 * forwards (the client's `git push -o <opt>` values, already filtered to a safe
 * charset by the hook). Returns a de-duped, non-empty token list.
 */
export function parsePushOptionsHeader(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const seen = new Set<string>();
  for (const tok of raw.split(',')) {
    const t = tok.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export function createGitSmartHttpRoutes(deps: GitSmartHttpDeps): Router {
  const router = Router();

  // ── ref advertisement ─────────────────────────────────────────────
  router.get('/git/:repo/info/refs', async (req, res) => {
    const service = req.query.service;
    if (typeof service !== 'string' || !SERVICES.has(service)) {
      // Dumb-protocol probe (no service param) — unsupported by design.
      res.status(400).type('text/plain').send('smart HTTP is required (missing service parameter)');
      return;
    }
    const resolved = resolveHostedProject(req.params.repo, deps);
    if (!resolved) {
      res.status(404).type('text/plain').send('Repository not found.');
      return;
    }
    const access = service === 'git-receive-pack' ? 'write' : 'read';
    if (!(await gateRequest(req, res, resolved.project, access))) return;

    req.setTimeout(0);
    res.status(200);
    res.set('Content-Type', `application/x-${service}-advertisement`);
    noCacheHeaders(res);

    // pkt-line preamble, then the raw advertisement from git itself.
    const preamble =
      service === 'git-upload-pack'
        ? '001e# service=git-upload-pack\n0000'
        : '001f# service=git-receive-pack\n0000';
    res.write(preamble);

    const child = spawn(
      'git',
      [
        ...gitServiceConfigArgs(service as GitService),
        serviceArgv(service as GitService),
        '--stateless-rpc',
        '--advertise-refs',
        resolved.repoPath,
      ],
      { env: packEnv(req), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    wireChildToResponse(child, req, res, `${service} advertise-refs`);
  });

  // ── pack RPC ──────────────────────────────────────────────────────
  for (const service of ['git-upload-pack', 'git-receive-pack'] as const) {
    router.post(`/git/:repo/${service}`, async (req, res) => {
      if (req.headers['content-type'] !== `application/x-${service}-request`) {
        res.status(415).type('text/plain').send(`expected application/x-${service}-request`);
        return;
      }
      const resolved = resolveHostedProject(req.params.repo, deps);
      if (!resolved) {
        res.status(404).type('text/plain').send('Repository not found.');
        return;
      }
      const access = service === 'git-receive-pack' ? 'write' : 'read';
      const caller = await gateRequest(req, res, resolved.project, access);
      if (!caller) return;
      // Stash the authenticated pusher so the post-receive notify hook
      // (which has no user identity) can attribute the push to them. Only
      // meaningful for receive-pack; upload-pack never notifies. The entry
      // is scoped to this request's lifetime — released on close — so two
      // overlapping pushes are detectable as ambiguous (and decline
      // attribution) rather than cross-attributing to each other.
      if (service === 'git-receive-pack') {
        const pusherToken = recordPusher(resolved.project.id, caller.userId);
        res.on('close', () => releasePusher(resolved.project.id, pusherToken));
      }

      req.setTimeout(0);
      res.status(200);
      res.set('Content-Type', `application/x-${service}-result`);
      noCacheHeaders(res);

      const child = spawn(
        'git',
        [
          ...gitServiceConfigArgs(service),
          serviceArgv(service),
          '--stateless-rpc',
          resolved.repoPath,
        ],
        {
          env: packEnv(req),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      // Request body → child stdin (gunzip when the client compressed it).
      const encoding = req.headers['content-encoding'];
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        const gunzip = createGunzip();
        gunzip.on('error', () => child.kill());
        req.pipe(gunzip).pipe(child.stdin!);
      } else {
        req.pipe(child.stdin!);
      }

      wireChildToResponse(child, req, res, service);
      // Note: for receive-pack, the repo's post-receive hook fires inside
      // the spawned process — mirror sync / UI notify need no extra
      // trigger here.
    });
  }

  // ── post-receive notify (from the bare repo's hook) ───────────────
  // The hook authenticates with the per-repo shared secret written to
  // `<bare>/agent-hub-notify.json` at repo creation / boot refresh — not
  // Basic auth, because the hook has no user identity. Body is the raw
  // `old new ref` lines from the hook's stdin (text/plain, no JSON
  // escaping needed in sh).
  router.post('/git/internal/hooks/post-receive', (req, res) => {
    const projectId = req.headers['x-agenthub-project'];
    const secret = req.headers['x-agenthub-secret'];
    if (typeof projectId !== 'string' || typeof secret !== 'string') {
      res.status(400).type('text/plain').send('missing project/secret headers');
      return;
    }
    let conf: ReturnType<typeof readNotifyConfig> = null;
    try {
      conf = readNotifyConfig(projectId, deps.dataDir ?? config.dataDir);
    } catch {
      conf = null; // invalid id shape → same 403 as a bad secret
    }
    const expected = conf?.secret ?? '';
    const matches =
      expected.length > 0 &&
      expected.length === secret.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(secret));
    if (!matches) {
      res.status(403).type('text/plain').send('invalid secret');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      const lines = Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const updates = lines
        .map((line) => {
          const [oldSha, newSha, ref] = line.split(/\s+/);
          return oldSha && newSha && ref ? { oldSha, newSha, ref } : null;
        })
        .filter((u): u is { oldSha: string; newSha: string; ref: string } => u !== null);

      deps.broadcast?.({
        type: 'git_host_push',
        projectId,
        refs: updates,
      });

      const project = deps.findProject(projectId);
      if (project && deps.broadcast) {
        void notifyMirrorPush(
          project,
          updates.map((u) => u.ref),
          { broadcast: deps.broadcast, dataDir: deps.dataDir },
        );
      }
      if (project && deps.onPush) {
        const pushedByUserId = takeRecentPusher(project.id);
        const pushOptions = parsePushOptionsHeader(req.headers['x-agenthub-push-options']);
        deps.onPush(
          project,
          updates.map((u) => u.ref),
          { pushedByUserId, pushOptions },
        );
      }
      res.status(204).end();
    });
  });

  // Everything else under /git/ (dumb-protocol object paths, stray URLs).
  router.all(/^\/git(\/.*)?$/, (_req, res) => {
    res.status(404).type('text/plain').send('Not found.');
  });

  return router;
}

/**
 * Pipe child stdout to the response, log stderr, and make sure neither a
 * client disconnect nor a child failure leaks a process or a hung socket.
 */
function wireChildToResponse(
  child: ReturnType<typeof spawn>,
  req: Request,
  res: Response,
  label: string,
): void {
  let streamed = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    streamed = true;
    res.write(chunk);
  });

  const stderrChunks: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderrChunks.length < 64) stderrChunks.push(chunk);
  });

  const kill = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };
  // Aborted clone/push — don't leave a pack process running. NOTE:
  // `req.on('close')` fires on normal completion too (once the request
  // body is fully consumed), so keying off it would kill the pack
  // process mid-response. The response 'close' with `writableEnded`
  // still false is the actual abort signal.
  res.on('close', () => {
    if (!res.writableEnded) kill();
  });

  child.on('error', (err) => {
    console.error(`[git-host] ${label}: spawn failed:`, err.message);
    if (!streamed && !res.headersSent) {
      res.status(500).type('text/plain').send('git spawn failed');
    } else {
      res.destroy();
    }
  });

  child.on('close', (code) => {
    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
      console.error(`[git-host] ${label}: exited ${code}${stderr ? `: ${stderr}` : ''}`);
      if (!streamed) {
        // Headers (200) are already sent for stream routes, so we can't
        // change the status — but destroying the socket mid-stream makes
        // the client report a transport error instead of hanging.
        res.destroy();
        return;
      }
    }
    res.end();
  });
}

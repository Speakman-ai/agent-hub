/**
 * Share links and member access for PR environments. The ingress side (what
 * a browser on `pr-<n>--<project>.<base>` has to present) lives in
 * `../preview/pr-environment-share.ts`.
 *
 * Only Agent Hub-hosted PRs have environments, and share links only make
 * sense with wildcard ingress configured: without it the environment URL is
 * the bare upstream and there is no host to gate.
 */
import { Router, type Request, type Response } from 'express';
import type { Project, PullRequestRow, RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { z, registerPath } from '../openapi/registry.js';
import { SHARE_UNSUPPORTED_CODES } from '../../shared/utils/prEnvironmentShare.js';
import { hasAtLeastRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { prEnvironmentSourceFor } from '../preview/pr-environment-github.js';
import { hashPassword } from '../password.js';
import { buildPrEnvironmentPublicUrl } from '../preview/preview-subdomain-host.js';
import {
  mintMemberTicket,
  prEnvironmentShareStoreFor,
  shareLinkStatus,
  shareTokenFor,
  SHARE_LINK_DEFAULT_HOURS,
  SHARE_LINK_MAX_HOURS,
  type PrEnvironmentShareStore,
  type ShareLinkRow,
} from '../preview/pr-environment-share.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorSchema = z.object({
  error: z.string(),
  code: z
    .enum([SHARE_UNSUPPORTED_CODES.ingressNotConfigured, SHARE_UNSUPPORTED_CODES.notHosted])
    .optional()
    .describe('Set when share links cannot exist here at all; clients hide the panel.'),
});
const PrParams = z.object({ projectId: z.string(), number: z.string() });

export const ShareLinkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  prNumber: z.number().int(),
  label: z.string().nullable(),
  url: z
    .string()
    .nullable()
    .describe(
      'The environment URL with `?share=<token>`. Opening it sets an HttpOnly cookie on that environment host only. Null once the link is revoked or expired.',
    ),
  status: z.enum(['active', 'expired', 'revoked']),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  canRevoke: z
    .boolean()
    .describe(
      'Whether the caller may revoke this link: it is active and the caller is an Admin/Owner, the PR author, or the link creator.',
    ),
});

export const CreateShareLinkBody = z.object({
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(SHARE_LINK_MAX_HOURS)
    .optional()
    .describe(
      `Lifetime in hours, 1 to ${SHARE_LINK_MAX_HOURS}. Default ${SHARE_LINK_DEFAULT_HOURS}.`,
    ),
  label: z.string().trim().max(120).optional().describe('Who the link is for, shown in the list.'),
});

export const SharePasswordBody = z.object({
  password: z
    .string()
    .min(4)
    .max(200)
    .nullable()
    .describe('New project share password, or null to remove it.'),
});

const ShareListResponse = z.object({
  links: z.array(ShareLinkSchema),
  passwordRequired: z.boolean(),
  canManage: z
    .boolean()
    .describe('Whether the caller may create and revoke links (Admin/Owner or the PR author).'),
  canSetPassword: z
    .boolean()
    .describe('Whether the caller may set the project password (Admin/Owner).'),
});

const notAvailable = {
  description: 'Not Hub-hosted, invalid PR number, or wildcard preview ingress is not configured.',
  content: jsonContent(ErrorSchema),
};

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/pulls/{number}/preview/share-links',
  tags: ['Projects'],
  summary: 'List share links for a PR environment',
  description:
    'Every share link created for this PR environment, newest first, with its status. Active links include their URL so it can be copied again.',
  request: { params: PrParams },
  responses: {
    200: { description: 'Links and permissions.', content: jsonContent(ShareListResponse) },
    400: notAvailable,
    404: { description: 'Unknown project/PR.', content: jsonContent(ErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/preview/share-links',
  tags: ['Projects'],
  summary: 'Create a share link for a PR environment',
  description:
    'Mints a signed, expiring, revocable link that lets someone without an Agent Hub account open this PR environment (and only this one). When the project has a share password, the visitor must also enter it. Admin/Owner or the PR author.',
  request: { params: PrParams, body: { content: jsonContent(CreateShareLinkBody) } },
  responses: {
    201: { description: 'Created.', content: jsonContent(z.object({ link: ShareLinkSchema })) },
    400: notAvailable,
    403: { description: 'Not Admin/Owner or the PR author.', content: jsonContent(ErrorSchema) },
    404: { description: 'Unknown project/PR.', content: jsonContent(ErrorSchema) },
    409: { description: 'The PR is not open.', content: jsonContent(ErrorSchema) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/pulls/{number}/preview/share-links/{linkId}',
  tags: ['Projects'],
  summary: 'Revoke a PR environment share link',
  description:
    'Revokes the link immediately: its next request, including from a browser that already holds the cookie, gets the access page. Idempotent. Admin/Owner, the PR author, or the link creator.',
  request: { params: PrParams.extend({ linkId: z.string() }) },
  responses: {
    200: { description: 'Revoked.', content: jsonContent(z.object({ link: ShareLinkSchema })) },
    400: notAvailable,
    403: { description: 'Not allowed to revoke this link.', content: jsonContent(ErrorSchema) },
    404: { description: 'Unknown project/PR/link.', content: jsonContent(ErrorSchema) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/pulls/{number}/preview/access',
  tags: ['Projects'],
  summary: 'Open a PR environment as a Hub member',
  description:
    'Returns the environment URL with a single-use ticket valid for 60 seconds. Opening it gives this browser a 12-hour session on that environment host. Any caller who can view the project.',
  request: { params: PrParams },
  responses: {
    200: { description: 'URL to open.', content: jsonContent(z.object({ url: z.string() })) },
    400: notAvailable,
    404: { description: 'Unknown project/PR.', content: jsonContent(ErrorSchema) },
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/preview-share/password',
  tags: ['Projects'],
  summary: 'Set or clear the project share password for PR environments',
  description:
    'When set, a visitor arriving with a share link must also enter this password. Hub members are not asked. Changing or clearing it signs out every share-link visitor who unlocked with the old one. Admin/Owner.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(SharePasswordBody) },
  },
  responses: {
    200: {
      description: 'Saved.',
      content: jsonContent(z.object({ passwordRequired: z.boolean() })),
    },
    400: { description: 'Invalid body or not Hub-hosted.', content: jsonContent(ErrorSchema) },
    403: { description: 'Not Admin/Owner.', content: jsonContent(ErrorSchema) },
    404: { description: 'Unknown project.', content: jsonContent(ErrorSchema) },
  },
});

export interface ShareLinkDto {
  id: string;
  projectId: string;
  prNumber: number;
  label: string | null;
  url: string | null;
  status: 'active' | 'expired' | 'revoked';
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  canRevoke: boolean;
}

export function toShareLinkDto(
  store: PrEnvironmentShareStore,
  row: ShareLinkRow,
  envUrl: string,
  now: number,
  /** Whether the caller is allowed to revoke this link at all (status aside). */
  mayRevoke: boolean,
): ShareLinkDto {
  const status = shareLinkStatus(row, now);
  let url: string | null = null;
  if (status === 'active') {
    const u = new URL(envUrl);
    u.searchParams.set('share', shareTokenFor(store.secret(), row));
    url = u.toString();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    prNumber: row.pr_number,
    label: row.label,
    url,
    status,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at == null ? null : new Date(row.revoked_at).toISOString(),
    canRevoke: mayRevoke && status === 'active',
  };
}

type ShareDeps = Pick<RouteDeps, 'findProject' | 'prEnvironments' | 'config'> & {
  now?: () => number;
};

export default function createPrEnvironmentShareRoutes(deps: ShareDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());

  interface Ctx {
    project: Project;
    number: number;
    /**
     * The Hub user who authored the PR. Null for GitHub-hosted PRs: their
     * author is a GitHub login, not a Hub user, so only Admins/Owners manage.
     */
    authorUserId: string | null;
    /** Whether new links may be created (the PR is open / its environment is live). */
    open: boolean;
    envUrl: string;
    store: PrEnvironmentShareStore;
  }

  const actor = (req: Request) => {
    const a = req as AuthenticatedRequest;
    return {
      userId: a.authUserId ?? null,
      role: a.authRole,
      name: a.authUser ?? a.authUserId ?? null,
    };
  };

  const isAdmin = (req: Request) => hasAtLeastRole(actor(req).role, 'Admin');
  const isAuthor = (req: Request, ctx: Ctx) => {
    const { userId } = actor(req);
    return Boolean(userId && ctx.authorUserId === userId);
  };

  const isCreator = (req: Request, link: ShareLinkRow) => {
    const me = actor(req);
    return Boolean(
      link.created_by && (link.created_by === me.userId || link.created_by === me.name),
    );
  };
  const mayRevoke = (req: Request, ctx: Ctx, link: ShareLinkRow) =>
    isAdmin(req) || isAuthor(req, ctx) || isCreator(req, link);

  function resolveCtx(req: Request, res: Response): Ctx | null {
    const project = deps.findProject(String(req.params.projectId)) as Project | null;
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    const source = prEnvironmentSourceFor(project);
    if (!source || !deps.prEnvironments) {
      res.status(400).json({
        error: 'Project is neither hosted on Agent Hub nor linked to a GitHub repo',
        code: SHARE_UNSUPPORTED_CODES.notHosted,
      });
      return null;
    }
    const number = Number.parseInt(String(req.params.number), 10);
    if (!Number.isFinite(number) || number <= 0 || String(number) !== String(req.params.number)) {
      res.status(400).json({ error: 'Invalid PR number' });
      return null;
    }
    const envUrl = buildPrEnvironmentPublicUrl(
      number,
      project.id,
      deps.config.previewSubdomainBase,
      deps.config.publicUrl,
    );
    if (!envUrl) {
      res.status(400).json({
        error:
          'PR environment access links need wildcard preview ingress (AGENT_HUB_PREVIEW_SUBDOMAIN_BASE).',
        code: SHARE_UNSUPPORTED_CODES.ingressNotConfigured,
      });
      return null;
    }
    // Pin the org once: the PR/environment rows and the share rows live in
    // the same database.
    const pinned = deps.prEnvironments.pin();
    const store = prEnvironmentShareStoreFor(pinned.org.db);
    if (source === 'github') {
      // The PR lives on GitHub; the environment row is the local truth.
      const env = pinned.get(project.id, { source, prNumber: number });
      return {
        project,
        number,
        authorUserId: null,
        // A sleeping env (stopped as idle) still belongs to an open PR.
        open: Boolean(env && (env.status !== 'stopped' || env.stopReason === 'idle')),
        envUrl,
        store,
      };
    }
    const pr = pinned.org.stmts.getPullRequestByNumber.get(project.id, number) as
      | PullRequestRow
      | undefined;
    if (!pr) {
      res.status(404).json({ error: `PR #${number} not found` });
      return null;
    }
    return { project, number, authorUserId: pr.author, open: pr.status === 'open', envUrl, store };
  }

  router.get(
    '/api/projects/:projectId/pulls/:number/preview/share-links',
    (req: Request, res: Response) => {
      const ctx = resolveCtx(req, res);
      if (!ctx) return;
      const t = now();
      const links = ctx.store
        .list({ projectId: ctx.project.id, prNumber: ctx.number })
        .map((row) => toShareLinkDto(ctx.store, row, ctx.envUrl, t, mayRevoke(req, ctx, row)));
      res.json({
        links,
        passwordRequired: ctx.store.getPassword(ctx.project.id) != null,
        canManage: isAdmin(req) || isAuthor(req, ctx),
        canSetPassword: isAdmin(req),
      });
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/preview/share-links',
    (req: Request, res: Response) => {
      const ctx = resolveCtx(req, res);
      if (!ctx) return;
      if (!isAdmin(req) && !isAuthor(req, ctx)) {
        return res
          .status(403)
          .json({ error: 'Only an Admin, Owner, or the PR author can create share links.' });
      }
      const parsed = CreateShareLinkBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      if (!ctx.open) {
        return res
          .status(409)
          .json({ error: `PR #${ctx.number} is not open or has no running environment` });
      }
      const t = now();
      const hours = parsed.data.expiresInHours ?? SHARE_LINK_DEFAULT_HOURS;
      const row = ctx.store.create({
        projectId: ctx.project.id,
        prNumber: ctx.number,
        label: parsed.data.label ? parsed.data.label : null,
        createdBy: actor(req).userId ?? actor(req).name,
        expiresAt: t + hours * 60 * 60_000,
        now: t,
      });
      return res
        .status(201)
        .json({ link: toShareLinkDto(ctx.store, row, ctx.envUrl, t, mayRevoke(req, ctx, row)) });
    },
  );

  router.delete(
    '/api/projects/:projectId/pulls/:number/preview/share-links/:linkId',
    (req: Request, res: Response) => {
      const ctx = resolveCtx(req, res);
      if (!ctx) return;
      const link = ctx.store.get(String(req.params.linkId));
      if (!link || link.project_id !== ctx.project.id || link.pr_number !== ctx.number) {
        return res.status(404).json({ error: 'Share link not found' });
      }
      const me = actor(req);
      if (!mayRevoke(req, ctx, link)) {
        return res.status(403).json({ error: 'Not allowed to revoke this share link.' });
      }
      const t = now();
      const revoked = ctx.store.revoke(link.id, me.userId ?? me.name, t)!;
      return res.json({ link: toShareLinkDto(ctx.store, revoked, ctx.envUrl, t, true) });
    },
  );

  router.post(
    '/api/projects/:projectId/pulls/:number/preview/access',
    (req: Request, res: Response) => {
      const ctx = resolveCtx(req, res);
      if (!ctx) return;
      const ticket = mintMemberTicket(
        ctx.store,
        { projectId: ctx.project.id, prNumber: ctx.number },
        actor(req).userId,
        now(),
      );
      const u = new URL(ctx.envUrl);
      u.searchParams.set('share', ticket);
      res.json({ url: u.toString() });
    },
  );

  router.put(
    '/api/projects/:projectId/preview-share/password',
    async (req: Request, res: Response) => {
      const project = deps.findProject(String(req.params.projectId)) as Project | null;
      if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (!prEnvironmentSourceFor(project) || !deps.prEnvironments) {
        return res.status(400).json({
          error: 'Project is not hosted on Agent Hub',
          code: SHARE_UNSUPPORTED_CODES.notHosted,
        });
      }
      if (!isAdmin(req)) {
        return res
          .status(403)
          .json({ error: 'Only an Admin or Owner can set the share password.' });
      }
      const parsed = SharePasswordBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const store = prEnvironmentShareStoreFor(deps.prEnvironments.pin().org.db);
      const hash = parsed.data.password == null ? null : await hashPassword(parsed.data.password);
      store.setPassword(project.id, hash, now());
      return res.json({ passwordRequired: hash != null });
    },
  );

  return router;
}

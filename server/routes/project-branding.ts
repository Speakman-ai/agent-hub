import { Router, type Request, type Response } from 'express';
import config from '../config.js';
import { requireRole } from '../roles.js';
import {
  ProjectEmailLogoError,
  deleteProjectEmailLogoFile,
  parseImageDataUrl,
  readProjectEmailLogo,
  writeProjectEmailLogo,
} from '../project-branding.js';
import {
  buildSampleReleaseDigestBody,
  renderBrandedEmailPreviewHtml,
  resolveBrandLogoDataUrl,
  toImageDataUrl,
} from '../email-branding.js';
import type { Project, RouteDeps } from '../types.js';
import { UpdateProjectEmailLogoRequestSchema } from './project-branding.openapi.js';

/**
 * Per-project email/deployment logo. Lets an Admin upload an image that
 * overrides the global branded-email logo for this project's release/deployment
 * notifications (see `server/project-branding.ts`). Reads are User+, writes are
 * Admin+, mirroring the release-notification-settings routes.
 */
export default function createProjectBrandingRoutes(deps: RouteDeps): Router {
  const router = Router();
  const { findProject, saveProjects } = deps;

  function resolveProject(req: Request, res: Response): Project | null {
    const project = findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  router.get(
    '/api/projects/:projectId/email-logo',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = resolveProject(req, res);
      if (!project) return;
      res.json({ emailLogo: project.emailLogo ?? null });
    },
  );

  // Raw image bytes for the settings preview. Separate from the metadata route
  // so an `<img>` can point straight at it (cache-bust with ?v=updatedAt).
  router.get(
    '/api/projects/:projectId/email-logo/raw',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = resolveProject(req, res);
      if (!project) return;
      const logo = project.emailLogo;
      if (!logo) return res.status(404).json({ error: 'No project email logo set' });
      const bytes = readProjectEmailLogo(project.id, logo);
      if (!bytes) return res.status(404).json({ error: 'Project email logo file missing' });
      res.setHeader('Content-Type', logo.contentType);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(bytes);
    },
  );

  // Rendered branded-email preview for the Settings UI: the exact email shell a
  // release/deployment notification uses, with the project logo (or the global
  // default, or the wordmark fallback) inlined as a data URL and a
  // representative digest body so an admin can eyeball logo + messaging before a
  // real deployment ships. Read-only (User+).
  router.get(
    '/api/projects/:projectId/release-email-preview',
    requireRole('User'),
    (req: Request, res: Response) => {
      const project = resolveProject(req, res);
      if (!project) return;
      // Mirror the send path's precedence exactly: the global `emailLogoEnabled`
      // kill switch wins first (no logo at all when off), then a per-project
      // logo overrides the global default.
      let logoDataUrl: string | null = null;
      // Whether the PROJECT logo bytes were actually resolved into the preview
      // (not just that metadata exists) — false when branding is disabled or the
      // stored file is missing and we fall back to the global logo.
      let usingProjectLogo = false;
      if (config.emailLogoEnabled) {
        if (project.emailLogo) {
          const bytes = readProjectEmailLogo(project.id, project.emailLogo);
          if (bytes) {
            logoDataUrl = toImageDataUrl(bytes, project.emailLogo.contentType);
            usingProjectLogo = true;
          }
        }
        if (!logoDataUrl) logoDataUrl = resolveBrandLogoDataUrl();
      }
      const body = buildSampleReleaseDigestBody(project.name);
      const html = renderBrandedEmailPreviewHtml(body, logoDataUrl);
      res.json({
        html,
        subject: `What's new in ${project.name || project.id}`,
        usingProjectLogo,
      });
    },
  );

  router.put(
    '/api/projects/:projectId/email-logo',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = resolveProject(req, res);
      if (!project) return;
      const parsed = UpdateProjectEmailLogoRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      const image = parseImageDataUrl(parsed.data.dataUrl);
      if (!image) {
        return res.status(400).json({ error: 'dataUrl must be a base64 data URL' });
      }
      const prev = project.emailLogo ?? null;
      // 1. Write the new logo to a fresh unique file — the prior file/metadata
      //    are left untouched so a later failure can roll back to them.
      let emailLogo;
      try {
        emailLogo = writeProjectEmailLogo(project.id, image.buffer, image.contentType);
      } catch (err: unknown) {
        if (err instanceof ProjectEmailLogoError) {
          return res.status(err.status).json({ error: err.message });
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('Project email logo upload error:', message);
        return res.status(500).json({ error: 'Failed to store project email logo' });
      }
      // 2. Persist metadata. Only if this succeeds do we commit the swap.
      project.emailLogo = emailLogo;
      try {
        saveProjects();
      } catch (err: unknown) {
        // Roll back: restore prior metadata and drop the orphaned new file, so
        // the previous override (file + metadata) stays fully intact.
        project.emailLogo = prev ?? undefined;
        deleteProjectEmailLogoFile(project.id, emailLogo);
        const message = err instanceof Error ? err.message : String(err);
        console.error('Project email logo persist error:', message);
        return res.status(500).json({ error: 'Failed to store project email logo' });
      }
      // 3. New bytes + metadata are durable — now remove the superseded file.
      if (prev && prev.filename !== emailLogo.filename) {
        deleteProjectEmailLogoFile(project.id, prev);
      }
      return res.json({ emailLogo });
    },
  );

  router.delete(
    '/api/projects/:projectId/email-logo',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = resolveProject(req, res);
      if (!project) return;
      const prev = project.emailLogo ?? null;
      if (!prev) return res.json({ ok: true, emailLogo: null });
      // Persist the removal BEFORE deleting bytes, and roll back metadata if the
      // write fails — never leave metadata pointing at a deleted file.
      delete project.emailLogo;
      try {
        saveProjects();
      } catch (err: unknown) {
        project.emailLogo = prev;
        const message = err instanceof Error ? err.message : String(err);
        console.error('Project email logo delete-persist error:', message);
        return res.status(500).json({ error: 'Failed to remove project email logo' });
      }
      deleteProjectEmailLogoFile(project.id, prev);
      return res.json({ ok: true, emailLogo: null });
    },
  );

  return router;
}

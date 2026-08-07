/**
 * Infrastructure setup wizard routes.
 *
 *   GET /api/projects/:projectId/infra/setup-draft
 *     Admin+. Returns `{ projectId, draft }` describing this project's
 *     monitoring readiness from **Hub-side state only** — configured AWS
 *     profiles and their types, whether a monitoring profile is designated,
 *     whether the module is enabled, the existing `infra_scopes` allowlist and
 *     the alert-rule counts — plus the `blockers[]` that still stand between the
 *     project and unattended collection.
 *
 * **This endpoint calls AWS zero times, by design** (decision INFRA-WIZARD).
 * The other setup wizards scan a repository; infra's equivalent input is a live
 * account, and probing one costs money and needs credentials that resolve. But
 * the wizard's most common first job is a project whose only profiles are
 * interactive SSO and which therefore cannot monitor anything at all — so a
 * draft that needed working credentials would break exactly when it is most
 * needed. Keeping it local also keeps it free and instant enough for the
 * Infrastructure empty state to call on every render. The live account probe
 * happens inside the spawned wizard session instead, performed by the agent
 * under the `aws-cli` skill's describe-only rules.
 *
 * Admin-gated to match the AWS profile and infra routes: the body names
 * profiles, regions and account ids. It never carries credential material — see
 * `infra-setup-draft.ts` for why that is a property of the import graph rather
 * than a review checklist item.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import type { RouteDeps, Project } from '../types.js';
import { collectInfraSetupDraft, type InfraSetupDraft } from '../infra-setup-draft.js';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import { listInfraScopes } from '../infra/infra-scope-store.js';
import { listInfraAlertRules } from '../infra/alert-store.js';
import { MAX_RESOURCE_STALENESS_MS } from '../infra/metric-collector.js';

/**
 * Read the Hub-side state the draft summarizes, then fold it in.
 *
 * The store reads live here rather than in `infra-setup-draft.ts` so that
 * module stays a pure function of its arguments — the same split
 * `logs-wizard.ts` uses when it enriches `collectLogsSetupDraft` with the
 * project's log sources. `isInfraDbInitialized()` is checked because
 * `listInfraScopes` would throw on a Hub that has never opened `infra.db`, and
 * the draft's whole job is to answer rather than fail.
 */
export function buildInfraSetupDraft(project: Project): InfraSetupDraft {
  const storageReady = isInfraDbInitialized();
  if (!storageReady) {
    return collectInfraSetupDraft(project, { storageReady: false });
  }
  return collectInfraSetupDraft(project, {
    storageReady: true,
    // Same staleness bound the collector and the scope editor use, so the
    // resource counts here match the ones the cost projection is priced on.
    scopes: listInfraScopes(project.id, MAX_RESOURCE_STALENESS_MS),
    alertRules: listInfraAlertRules({ projectId: project.id }),
  });
}

export default function createInfraWizardRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/infra/setup-draft',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      // No `cwd` precondition, unlike the repo-scanning wizards: there is
      // nothing on disk to read, and a project with no working copy can still
      // be monitored.
      res.json({ projectId: project.id, draft: buildInfraSetupDraft(project) });
    },
  );

  return router;
}

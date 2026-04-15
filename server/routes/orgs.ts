import { Router, Request, Response } from 'express';
import { mkdirSync } from 'fs';
import {
  getAllOrgs,
  getOrg,
  createOrg as createOrgRecord,
  updateOrg as updateOrgRecord,
  deleteOrg as deleteOrgRecord,
  orgDataDir,
  setActiveOrgId,
} from '../orgs.js';
import type { RouteDeps, EnrichedAgent } from '../types.js';

export default function createOrgRoutes(deps: RouteDeps): Router {
  const {
    initDb,
    broadcast,
    allAgents,
    reloadProjects,
    getProjects,
    autonomousCrons,
    restoreAutonomousCrons,
    setActiveDataDir,
  } = deps;
  const scheduleAll = deps.scheduleAll as (agents: EnrichedAgent[]) => void;
  const router = Router();

  function performOrgSwitch(orgId: string): void {
    const dataDir = orgDataDir(orgId);
    mkdirSync(dataDir, { recursive: true });

    console.log(`[Org] Switching to org ${orgId} → ${dataDir}`);

    initDb(dataDir);
    setActiveDataDir(dataDir);
    setActiveOrgId(orgId);

    reloadProjects(dataDir);
    scheduleAll(allAgents());

    for (const [_key, task] of autonomousCrons) {
      (task as { stop: () => void }).stop();
    }
    autonomousCrons.clear();
    restoreAutonomousCrons();

    broadcast({ type: 'org_switched', orgId, dataDir });
  }

  router.get('/api/orgs', (_req: Request, res: Response) => {
    res.json(getAllOrgs());
  });

  router.get('/api/orgs/:id', (req: Request, res: Response) => {
    const org = getOrg(req.params.id as string);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  router.post('/api/orgs', (req: Request, res: Response) => {
    const { id, name, mode, color, remoteUrl, apiKey } = req.body as {
      id?: string;
      name?: string;
      mode?: string;
      color?: string;
      remoteUrl?: string;
      apiKey?: string;
    };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const org = createOrgRecord({ id, name, mode, color, remoteUrl, apiKey });
    res.status(201).json(org);
  });

  router.put('/api/orgs/:id', (req: Request, res: Response) => {
    const { name, mode, color, remoteUrl, apiKey, position } = req.body as {
      name?: string;
      mode?: string;
      color?: string;
      remoteUrl?: string;
      apiKey?: string;
      position?: number;
    };
    const org = updateOrgRecord(req.params.id as string, {
      name,
      mode,
      color,
      remoteUrl,
      apiKey,
      position,
    });
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  router.delete('/api/orgs/:id', (req: Request, res: Response) => {
    const ok = deleteOrgRecord(req.params.id as string);
    if (!ok) return res.status(400).json({ error: 'Cannot delete the last org' });
    res.json({ ok: true });
  });

  router.post('/api/orgs/:id/switch', (req: Request, res: Response) => {
    const org = getOrg(req.params.id as string);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    try {
      performOrgSwitch(org.id);
      res.json({
        ok: true,
        orgId: org.id,
        projects: getProjects().length,
        agents: allAgents().length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Org] Switch failed:', message);
      res.status(500).json({ error: `Failed to switch org: ${message}` });
    }
  });

  router.post('/api/org/switch', (req: Request, res: Response) => {
    const { orgId } = req.body as { orgId?: string };
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    try {
      performOrgSwitch(orgId);
      res.json({ ok: true, orgId, projects: getProjects().length, agents: allAgents().length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Org] Switch failed:', message);
      res.status(500).json({ error: `Failed to switch org: ${message}` });
    }
  });

  return router;
}

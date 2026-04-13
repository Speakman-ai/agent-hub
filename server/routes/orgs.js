import { Router } from 'express';
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

export default function createOrgRoutes(deps) {
  const {
    initDb,
    broadcast,
    allAgents,
    scheduleAll,
    reloadProjects,
    getProjects,
    autonomousCrons,
    restoreAutonomousCrons,
    setActiveDataDir,
  } = deps;
  const router = Router();

  /** Internal helper: perform the data-directory switch for an org. */
  function performOrgSwitch(orgId) {
    const dataDir = orgDataDir(orgId);
    mkdirSync(dataDir, { recursive: true });

    console.log(`[Org] Switching to org ${orgId} → ${dataDir}`);

    initDb(dataDir);
    setActiveDataDir(dataDir);
    setActiveOrgId(orgId);

    reloadProjects(dataDir);
    scheduleAll(allAgents());

    for (const [_key, task] of autonomousCrons) {
      task.stop();
    }
    autonomousCrons.clear();
    restoreAutonomousCrons();

    broadcast({ type: 'org_switched', orgId, dataDir });
  }

  // List all orgs
  router.get('/api/orgs', (_req, res) => {
    res.json(getAllOrgs());
  });

  // Get single org
  router.get('/api/orgs/:id', (req, res) => {
    const org = getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  // Create a new org
  router.post('/api/orgs', (req, res) => {
    const { id, name, mode, color, remoteUrl, apiKey } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const org = createOrgRecord({ id, name, mode, color, remoteUrl, apiKey });
    res.status(201).json(org);
  });

  // Update an org
  router.put('/api/orgs/:id', (req, res) => {
    const { name, mode, color, remoteUrl, apiKey, position } = req.body;
    const org = updateOrgRecord(req.params.id, { name, mode, color, remoteUrl, apiKey, position });
    if (!org) return res.status(404).json({ error: 'Org not found' });
    res.json(org);
  });

  // Delete an org
  router.delete('/api/orgs/:id', (req, res) => {
    const ok = deleteOrgRecord(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot delete the last org' });
    res.json({ ok: true });
  });

  // Switch active org (tells the server to change its data directory)
  router.post('/api/orgs/:id/switch', (req, res) => {
    const org = getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    try {
      performOrgSwitch(org.id);
      res.json({
        ok: true,
        orgId: org.id,
        projects: getProjects().length,
        agents: allAgents().length,
      });
    } catch (err) {
      console.error('[Org] Switch failed:', err.message);
      res.status(500).json({ error: `Failed to switch org: ${err.message}` });
    }
  });

  // Legacy endpoint — redirect to new API for backwards compat
  router.post('/api/org/switch', (req, res) => {
    const { orgId } = req.body;
    if (!orgId) return res.status(400).json({ error: 'orgId is required' });

    try {
      performOrgSwitch(orgId);
      res.json({ ok: true, orgId, projects: getProjects().length, agents: allAgents().length });
    } catch (err) {
      console.error('[Org] Switch failed:', err.message);
      res.status(500).json({ error: `Failed to switch org: ${err.message}` });
    }
  });

  return router;
}

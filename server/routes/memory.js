import { Router } from 'express';
import { runWikiMemorySync } from '../heartbeat.js';

export default function createMemoryRoutes() {
  const router = Router();

  // ── Manual trigger for wiki → memory reconciliation ──────────────
  router.post('/api/memory/reconcile', (_req, res) => {
    res.json({ status: 'running' });
    runWikiMemorySync().catch((err) => {
      console.error('[Wiki→Memory Sync] Manual trigger failed:', err.message);
    });
  });

  return router;
}

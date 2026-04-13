import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Router } from 'express';
import config from '../config.js';

export function getWebhookCallbackUrl() {
  const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/github`;
}

export function parseGitHubRepo(repoUrl) {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) throw new Error('Cannot parse repo owner/name from URL');
  return { owner: match[1], repo: match[2] };
}

export function ghApi(...args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf-8', timeout: 15000 });
}

export async function registerWebhookOnGitHub(webhookConfig) {
  const { owner, repo } = parseGitHubRepo(webhookConfig.repo_url);
  const webhookUrl = getWebhookCallbackUrl();

  const events = Object.keys(JSON.parse(webhookConfig.events || '{}')).map((e) => e.split('.')[0]);
  const uniqueEvents = [...new Set(events)].filter(Boolean);
  if (uniqueEvents.length === 0) uniqueEvents.push('push', 'pull_request', 'issues');

  try {
    const existingRaw = ghApi(
      `repos/${owner}/${repo}/hooks`,
      '--jq',
      `[.[] | select(.config.url=="${webhookUrl}")]`,
    );
    const existing = JSON.parse(existingRaw || '[]');
    if (existing.length > 0) {
      const hookId = existing[0].id;
      const updateArgs = [
        `repos/${owner}/${repo}/hooks/${hookId}`,
        '--method',
        'PATCH',
        '--field',
        'active=true',
        '--field',
        `config[url]=${webhookUrl}`,
        '--field',
        'config[content_type]=json',
        '--field',
        `config[secret]=${webhookConfig.secret}`,
        ...uniqueEvents.flatMap((e) => ['--field', `events[]=${e}`]),
      ];
      const result = JSON.parse(ghApi(...updateArgs));
      return { ok: true, hookId: result.id, url: webhookUrl, events: uniqueEvents, updated: true };
    }
  } catch {
    // If listing fails (permissions etc.), fall through to create
  }

  const createArgs = [
    `repos/${owner}/${repo}/hooks`,
    '--method',
    'POST',
    '--field',
    'name=web',
    '--field',
    'active=true',
    '--field',
    `config[url]=${webhookUrl}`,
    '--field',
    'config[content_type]=json',
    '--field',
    `config[secret]=${webhookConfig.secret}`,
    ...uniqueEvents.flatMap((e) => ['--field', `events[]=${e}`]),
  ];
  const result = JSON.parse(ghApi(...createArgs));
  return { ok: true, hookId: result.id, url: webhookUrl, events: uniqueEvents, updated: false };
}

export default function createWebhookRoutes(deps) {
  const { stmts } = deps;
  const router = Router();

  router.get('/api/webhooks', (_req, res) => {
    res.json(stmts.getWebhookConfigs.all());
  });

  router.get('/api/webhooks/project/:projectId', (req, res) => {
    res.json(stmts.getWebhookConfigsByProject.all(req.params.projectId));
  });

  router.post('/api/webhooks', async (req, res) => {
    const { projectId, repoUrl, events, enabled, autoRegister } = req.body;
    if (!projectId || !repoUrl)
      return res.status(400).json({ error: 'projectId and repoUrl required' });

    const secret = crypto.randomBytes(32).toString('hex');
    const result = stmts.createWebhookConfig.run(
      projectId,
      repoUrl,
      secret,
      JSON.stringify(events || {}),
      enabled !== false ? 1 : 0,
    );

    const created = stmts.getWebhookConfig.get(result.lastInsertRowid);

    if (autoRegister) {
      try {
        const regResult = await registerWebhookOnGitHub(created);
        return res.json({ ...created, registration: regResult });
      } catch (err) {
        return res.json({ ...created, registration: { ok: false, error: err.message } });
      }
    }

    res.json(created);
  });

  router.put('/api/webhooks/:id', (req, res) => {
    const { repoUrl, events, enabled } = req.body;
    const existing = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Not found' });

    stmts.updateWebhookConfig.run(
      repoUrl || existing.repo_url,
      JSON.stringify(events || JSON.parse(existing.events)),
      enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
      existing.id,
    );

    res.json(stmts.getWebhookConfig.get(existing.id));
  });

  router.delete('/api/webhooks/:id', (req, res) => {
    stmts.deleteWebhookConfig.run(parseInt(req.params.id));
    res.json({ ok: true });
  });

  router.get('/api/webhooks/:id/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    res.json(stmts.getWebhookLogs.all(parseInt(req.params.id), limit));
  });

  router.get('/api/webhooks/logs/recent', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    res.json(stmts.getRecentWebhookLogs.all(limit));
  });

  router.post('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    try {
      const result = await registerWebhookOnGitHub(webhookConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Failed to register webhook: ${err.message}` });
    }
  });

  router.delete('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo;
    try {
      ownerRepo = parseGitHubRepo(webhookConfig.repo_url);
    } catch {
      return res.status(400).json({ error: 'Cannot parse repo from URL' });
    }

    const { owner, repo } = ownerRepo;
    const webhookUrl = getWebhookCallbackUrl();

    try {
      const existingRaw = ghApi(
        `repos/${owner}/${repo}/hooks`,
        '--jq',
        `[.[] | select(.config.url=="${webhookUrl}")]`,
      );
      const existing = JSON.parse(existingRaw || '[]');
      for (const hook of existing) {
        ghApi(`repos/${owner}/${repo}/hooks/${hook.id}`, '--method', 'DELETE');
      }
      res.json({ ok: true, removed: existing.length });
    } catch (err) {
      res.status(500).json({ error: `Failed to unregister webhook: ${err.message}` });
    }
  });

  router.get('/api/webhooks/:id/register', async (req, res) => {
    const webhookConfig = stmts.getWebhookConfig.get(parseInt(req.params.id));
    if (!webhookConfig) return res.status(404).json({ error: 'Not found' });

    let ownerRepo;
    try {
      ownerRepo = parseGitHubRepo(webhookConfig.repo_url);
    } catch {
      return res.status(400).json({ error: 'Cannot parse repo from URL' });
    }

    const { owner, repo } = ownerRepo;
    const webhookUrl = getWebhookCallbackUrl();

    try {
      const existingRaw = ghApi(
        `repos/${owner}/${repo}/hooks`,
        '--jq',
        `[.[] | select(.config.url=="${webhookUrl}") | {id, active, events, config: {url: .config.url}, last_response: .last_response}]`,
      );
      const hooks = JSON.parse(existingRaw || '[]');
      res.json({ registered: hooks.length > 0, hooks, webhookUrl });
    } catch (err) {
      res.json({ registered: false, error: err.message, webhookUrl });
    }
  });

  return router;
}

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';

/**
 * Valid escalation types:
 * - merge_conflict: PR has merge conflicts that cannot be auto-resolved
 * - ci_failure: CI checks failing after multiple retry attempts
 * - review_needed: Review comments that require human judgment
 * - blocker: Any blocker flagged by an agent
 */
const VALID_TYPES = ['merge_conflict', 'ci_failure', 'review_needed', 'blocker'];

/**
 * Create an escalation record and broadcast it via WebSocket.
 *
 * This is exported so webhook handlers and other modules can create
 * escalations without going through the HTTP API.
 *
 * @param {object} deps - { stmts, broadcast }
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.type - one of VALID_TYPES
 * @param {string} opts.title - short summary of what needs attention
 * @param {string} [opts.description] - detailed explanation of the issue
 * @param {number} [opts.prNumber]
 * @param {string} [opts.prUrl]
 * @param {string} [opts.cardId]
 * @param {string} [opts.source] - e.g. 'webhook', 'cron', 'agent'
 * @param {boolean} [opts.silent] - if true, skip broadcast and Slack notification (for tracking-only records)
 * @param {boolean} [opts.skipSlack] - if true, skip Slack notification only (caller handles Slack separately)
 * @returns {object} the created escalation row
 */
export function createEscalation(deps, opts) {
  const { stmts, broadcast } = deps;
  const {
    projectId,
    type,
    title,
    description = '',
    prNumber = null,
    prUrl = null,
    cardId = null,
    source = null,
    silent = false,
    skipSlack = false,
  } = opts;

  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid escalation type: ${type}`);
  }

  const id = uuidv4();
  stmts.createEscalation.run(
    id,
    projectId,
    type,
    title,
    description,
    prNumber,
    prUrl,
    cardId,
    source,
  );
  // Silent mode: immediately acknowledge so it won't appear in the active
  // escalation list, but the row persists for dedup checks (e.g. detecting
  // repeated CI failures). Callers should use getAnyRecentEscalationByTypeAndPr
  // when they need to find silent tracking records.
  if (silent) {
    stmts.acknowledgeEscalation.run(id);
  }

  const escalation = stmts.getEscalation.get(id);

  // Silent escalations are tracking-only records (e.g. first CI failure) —
  // no broadcast or Slack so the UI doesn't alert the user prematurely.
  if (!silent) {
    broadcast({
      type: 'escalation_created',
      escalation,
    });
  }

  // Optional Slack notification (skip if silent or caller handles Slack separately)
  if (config.slackWebhookUrl && !silent && !skipSlack) {
    const typeEmoji = {
      merge_conflict: '\u26A0\uFE0F',
      ci_failure: '\u274C',
      review_needed: '\uD83D\uDC41\uFE0F',
      blocker: '\uD83D\uDED1',
    };
    fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${typeEmoji[type] || '\u26A0\uFE0F'} *Escalation: ${title}*\n${description}${prUrl ? `\n<${prUrl}|View PR>` : ''}`,
      }),
    }).catch(() => {});
  }

  return escalation;
}

export default function createEscalationRoutes(deps) {
  const { stmts, broadcast, findProject } = deps;
  const router = Router();

  // GET /api/escalations — list all active (unacknowledged) escalations
  router.get('/api/escalations', (_req, res) => {
    const escalations = stmts.getAllActiveEscalations.all();
    res.json(escalations);
  });

  // GET /api/projects/:projectId/escalations — list escalations for a project
  router.get('/api/projects/:projectId/escalations', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { active } = req.query;
    const escalations =
      active === 'true'
        ? stmts.getActiveEscalationsByProject.all(project.id)
        : stmts.getEscalationsByProject.all(project.id);

    res.json(escalations);
  });

  // POST /api/projects/:projectId/escalations — create an escalation
  router.post('/api/projects/:projectId/escalations', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type, title, description, prNumber, prUrl, cardId, source } = req.body;
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const escalation = createEscalation(
      { stmts, broadcast },
      { projectId: project.id, type, title, description, prNumber, prUrl, cardId, source },
    );

    res.status(201).json(escalation);
  });

  // POST /api/escalations/:id/acknowledge — mark escalation as handled
  router.post('/api/escalations/:id/acknowledge', (req, res) => {
    const escalation = stmts.getEscalation.get(req.params.id);
    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });

    stmts.acknowledgeEscalation.run(escalation.id);
    const updated = stmts.getEscalation.get(escalation.id);

    broadcast({
      type: 'escalation_acknowledged',
      escalation: updated,
    });

    res.json(updated);
  });

  // DELETE /api/escalations/:id — dismiss/delete an escalation
  router.delete('/api/escalations/:id', (req, res) => {
    const escalation = stmts.getEscalation.get(req.params.id);
    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });

    stmts.deleteEscalation.run(escalation.id);

    broadcast({
      type: 'escalation_dismissed',
      escalationId: escalation.id,
      projectId: escalation.project_id,
    });

    res.json({ ok: true });
  });

  return router;
}

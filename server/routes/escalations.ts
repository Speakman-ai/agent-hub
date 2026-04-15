import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import type { RouteDeps, EscalationRow, Stmts, BroadcastFn } from '../types.js';

const VALID_TYPES = ['merge_conflict', 'ci_failure', 'review_needed', 'blocker'] as const;
type EscalationType = (typeof VALID_TYPES)[number];

interface CreateEscalationDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

interface CreateEscalationOpts {
  projectId: string;
  type: EscalationType;
  title: string;
  description?: string;
  prNumber?: number | null;
  prUrl?: string | null;
  cardId?: string | null;
  source?: string | null;
  silent?: boolean;
  skipSlack?: boolean;
}

export function createEscalation(
  deps: CreateEscalationDeps,
  opts: CreateEscalationOpts,
): EscalationRow {
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

  if (!(VALID_TYPES as readonly string[]).includes(type)) {
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
  if (silent) {
    stmts.acknowledgeEscalation.run(id);
  }

  const escalation = stmts.getEscalation.get(id) as EscalationRow;

  if (!silent) {
    broadcast({
      type: 'escalation_created',
      escalation,
    });
  }

  if (config.slackWebhookUrl && !silent && !skipSlack) {
    const typeEmoji: Record<string, string> = {
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

export default function createEscalationRoutes(deps: RouteDeps): Router {
  const { stmts, broadcast, findProject } = deps;
  const router = Router();

  router.get('/api/escalations', (_req: Request, res: Response) => {
    const escalations = stmts.getAllActiveEscalations.all();
    res.json(escalations);
  });

  router.get('/api/projects/:projectId/escalations', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { active } = req.query;
    const escalations =
      active === 'true'
        ? stmts.getActiveEscalationsByProject.all(project.id)
        : stmts.getEscalationsByProject.all(project.id);

    res.json(escalations);
  });

  router.post('/api/projects/:projectId/escalations', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type, title, description, prNumber, prUrl, cardId, source } = req.body as {
      type?: string;
      title?: string;
      description?: string;
      prNumber?: number;
      prUrl?: string;
      cardId?: string;
      source?: string;
    };
    if (!type || !(VALID_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const escalation = createEscalation(
      { stmts, broadcast },
      {
        projectId: project.id,
        type: type as EscalationType,
        title,
        description,
        prNumber,
        prUrl,
        cardId,
        source,
      },
    );

    res.status(201).json(escalation);
  });

  router.post('/api/escalations/:id/acknowledge', (req: Request, res: Response) => {
    const escalation = stmts.getEscalation.get(req.params.id) as EscalationRow | undefined;
    if (!escalation) return res.status(404).json({ error: 'Escalation not found' });

    stmts.acknowledgeEscalation.run(escalation.id);
    const updated = stmts.getEscalation.get(escalation.id) as EscalationRow;

    broadcast({
      type: 'escalation_acknowledged',
      escalation: updated,
    });

    res.json(updated);
  });

  router.delete('/api/escalations/:id', (req: Request, res: Response) => {
    const escalation = stmts.getEscalation.get(req.params.id) as EscalationRow | undefined;
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

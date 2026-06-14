import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  updateSupportTicketStatus,
  recordSupportTicketInvestigation,
  setSupportTicketReplayRef,
  deleteSupportTicket,
  SUPPORT_TICKET_STATUSES,
} from '../support-tickets-store.js';
import type { SupportTicketStatus } from '../types.js';

/**
 * Support ticket queue routes. Tickets are persisted in their own
 * project-scoped queue (see `support_tickets`), separate from the kanban
 * board. The list endpoint returns rows ordered by severity (most severe
 * first) so the most urgent requests sit at the top.
 */
export default function createSupportTicketRoutes(deps: RouteDeps): Router {
  const { broadcast, findProject } = deps;
  const router = Router();

  router.get('/api/projects/:projectId/support-tickets', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const status = req.query.status as string | undefined;
    if (status && !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}` });
    }

    const tickets = listSupportTickets(project.id, {
      status: status as SupportTicketStatus | undefined,
    });
    res.json(tickets);
  });

  router.get('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ticket = getSupportTicket(req.params.id as string);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }
    res.json(ticket);
  });

  router.post('/api/projects/:projectId/support-tickets', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { type, severity, subject, body, reporter, replayRef } = req.body as {
      type?: string;
      severity?: string;
      subject?: string;
      body?: string;
      reporter?: string;
      replayRef?: string;
    };

    try {
      const ticket = createSupportTicket({
        projectId: project.id,
        type: type as never,
        severity: severity as never,
        subject,
        body: body ?? '',
        reporter: reporter ?? null,
        replayRef: replayRef ?? null,
      });
      broadcast({ type: 'support_ticket_created', ticket });
      res.status(201).json(ticket);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const existing = getSupportTicket(req.params.id as string);
    if (!existing || existing.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }

    const { status, aiSummary, aiInvestigation, replayRef } = req.body as {
      status?: string;
      aiSummary?: string | null;
      aiInvestigation?: string | null;
      replayRef?: string | null;
    };

    try {
      let ticket = existing;
      if (status !== undefined) {
        ticket = updateSupportTicketStatus(ticket.id, status as SupportTicketStatus)!;
      }
      if (aiSummary !== undefined || aiInvestigation !== undefined) {
        // Pass the raw values through: the store preserves fields left
        // `undefined` and treats an explicit `null` as a clear, so sending
        // only one field never wipes the other.
        ticket = recordSupportTicketInvestigation(ticket.id, {
          summary: aiSummary,
          details: aiInvestigation,
        })!;
      }
      if (replayRef !== undefined) {
        ticket = setSupportTicketReplayRef(ticket.id, replayRef)!;
      }
      broadcast({ type: 'support_ticket_updated', ticket });
      res.json(ticket);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/support-tickets/:id', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const ticket = getSupportTicket(req.params.id as string);
    if (!ticket || ticket.project_id !== project.id) {
      return res.status(404).json({ error: 'Support ticket not found' });
    }

    deleteSupportTicket(ticket.id);
    broadcast({
      type: 'support_ticket_deleted',
      ticketId: ticket.id,
      projectId: project.id,
    });
    res.json({ ok: true });
  });

  return router;
}

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { defaultModelForEngine } from '../config.js';
import type {
  RouteDeps,
  Stmts,
  KanbanBoardRow,
  KanbanColumnRow,
  KanbanCardRow,
  KanbanEpicRow,
  KanbanBlockerLink,
  KanbanCardBlockerRow,
} from '../types.js';
import { findCycle, loadBoardBlockers } from '../kanban-blockers.js';

interface BoardData {
  board: KanbanBoardRow;
  columns: KanbanColumnRow[];
  cards: KanbanCardRow[];
  epics: KanbanEpicRow[];
}

/** A card row enriched with its blocker relationships. */
interface EnrichedCard extends KanbanCardRow {
  blockers: KanbanBlockerLink[];
  blocks: KanbanBlockerLink[];
}

export function getOrCreateBoard(stmts: Stmts, projectId: string): BoardData {
  let board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
  if (board) {
    return {
      board,
      columns: stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[],
      cards: stmts.getKanbanCards.all(board.id) as KanbanCardRow[],
      epics: stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[],
    };
  }
  const boardId = uuidv4();
  stmts.createKanbanBoard.run(boardId, projectId, 'Board');
  const defaultColumns = [
    { name: 'Backlog', color: '#6B7280' },
    { name: 'To Do', color: '#3B82F6' },
    { name: 'In Progress', color: '#F59E0B' },
    { name: 'Review', color: '#8B5CF6' },
    { name: 'Done', color: '#10B981' },
  ];
  for (let i = 0; i < defaultColumns.length; i++) {
    stmts.createKanbanColumn.run(
      uuidv4(),
      boardId,
      defaultColumns[i].name,
      i,
      defaultColumns[i].color,
    );
  }
  board = stmts.getKanbanBoardById.get(boardId) as KanbanBoardRow | undefined;
  return {
    board: board!,
    columns: stmts.getKanbanColumns.all(boardId) as KanbanColumnRow[],
    cards: [],
    epics: [],
  };
}

export default function createBoardRoutes(deps: RouteDeps): Router {
  const {
    findProject,
    findAgent,
    broadcast,
    stmts,
    handleChat,
    pendingReviewComments,
    lastDispatchedReviewId,
    scheduleAutonomousEpic,
    autonomousCrons,
    runAutonomousLoop,
  } = deps;

  const router = Router();

  router.get('/api/projects/:projectId/board', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const data = getOrCreateBoard(stmts, req.params.projectId as string);
    // Annotate each card with its blocker relationships. A single indexed
    // query fetches every edge on the board; we then attach empty arrays
    // for cards with no blockers so clients can rely on the shape.
    const index = loadBoardBlockers(stmts, data.board.id);
    const enrichedCards: EnrichedCard[] = data.cards.map((c) => ({
      ...c,
      blockers: index.blockersByCard.get(c.id) ?? [],
      blocks: index.blocksByCard.get(c.id) ?? [],
    }));
    res.json({ ...data, cards: enrichedCards });
  });

  router.post('/api/projects/:projectId/board/columns', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, color } = req.body as { name?: string; color?: string };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { board, columns } = getOrCreateBoard(stmts, req.params.projectId as string);
    const maxPos = columns.length > 0 ? Math.max(...columns.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanColumn.run(id, board.id, name, maxPos, color || null);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanColumns.all(board.id));
  });

  router.put('/api/projects/:projectId/board/columns/:columnId', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, position, color } = req.body as {
      name?: string;
      position?: number;
      color?: string;
    };
    stmts.updateKanbanColumn.run(name, position, color || null, req.params.columnId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.delete(
    '/api/projects/:projectId/board/columns/:columnId',
    (req: Request, res: Response) => {
      stmts.deleteKanbanColumn.run(req.params.columnId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json({ ok: true });
    },
  );

  router.get('/api/projects/:projectId/board/cards', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(stmts.getKanbanCards.all(board.id));
  });

  router.post('/api/projects/:projectId/board/cards', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const body = req.body as Record<string, unknown>;
    const title = body.title as string | undefined;
    const description = body.description as string | undefined;
    const priority = body.priority as string | undefined;
    const assignee = body.assignee as string | undefined;
    const labels = body.labels as string | undefined;
    const columnId = (body.columnId ?? body.column_id) as string | undefined;
    const sessionId = (body.sessionId ?? body.session_id) as string | undefined;
    const githubIssueUrl = (body.githubIssueUrl ?? body.github_issue_url) as string | undefined;
    const createdBy = (body.createdBy ?? body.created_by) as string | undefined;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);

    // Deduplication: check for existing card with same title (case-insensitive) on this board
    const allBoardCards = stmts.getKanbanCards.all(board.id) as KanbanCardRow[];
    const titleLower = title.toLowerCase().trim();
    const duplicate = allBoardCards.find((c) => c.title.toLowerCase().trim() === titleLower);
    if (duplicate) {
      // Return the existing card instead of creating a duplicate
      return res.json(duplicate);
    }

    const existingCards = stmts.getKanbanCardsByColumn.all(columnId) as KanbanCardRow[];
    const maxPos =
      existingCards.length > 0 ? Math.max(...existingCards.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanCard.run(
      id,
      columnId,
      board.id,
      title,
      description || null,
      priority || 'medium',
      assignee || null,
      labels || null,
      sessionId || null,
      githubIssueUrl || null,
      createdBy || null,
      maxPos,
    );
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCard.get(id));
  });

  router.put('/api/projects/:projectId/board/cards/:cardId', (req: Request, res: Response) => {
    const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const body = req.body as Record<string, unknown>;

    // Non-nullable fields: only overwrite when a new value is supplied.
    const title = body.title as string | undefined;
    const priority = body.priority as string | undefined;

    // Nullable fields: an explicit `null` (or `null` via snake_case alias) must
    // clear the column. `??` treats `null` as absent, so we check key
    // presence instead — that's the only way the client can drop a value.
    const hasDescription = 'description' in body;
    const description = body.description as string | null | undefined;

    const hasAssignee = 'assignee' in body;
    const assignee = body.assignee as string | null | undefined;

    const hasLabels = 'labels' in body;
    const labels = body.labels as string | null | undefined;

    const hasSessionId = 'sessionId' in body || 'session_id' in body;
    const sessionId = (body.sessionId ?? body.session_id) as string | null | undefined;

    const hasGithubIssueUrl = 'githubIssueUrl' in body || 'github_issue_url' in body;
    const githubIssueUrl = (body.githubIssueUrl ?? body.github_issue_url) as
      | string
      | null
      | undefined;

    const hasPrUrl = 'prUrl' in body || 'pr_url' in body;
    const prUrl = (body.prUrl ?? body.pr_url) as string | null | undefined;

    const hasEpicId = 'epicId' in body || 'epic_id' in body;
    const epicId = (body.epicId ?? body.epic_id) as string | null | undefined;

    stmts.updateKanbanCard.run(
      title ?? card.title,
      hasDescription ? (description ?? null) : card.description,
      priority ?? card.priority,
      hasAssignee ? (assignee ?? null) : card.assignee,
      hasLabels ? (labels ?? null) : card.labels,
      hasSessionId ? (sessionId ?? null) : card.session_id,
      hasGithubIssueUrl ? (githubIssueUrl ?? null) : card.github_issue_url,
      hasPrUrl ? (prUrl ?? null) : card.pr_url,
      hasEpicId ? (epicId ?? null) : card.epic_id,
      req.params.cardId,
    );
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCard.get(req.params.cardId));
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/move',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const { columnId, position } = req.body as { columnId?: string; position?: number };
      if (!columnId) return res.status(400).json({ error: 'columnId is required' });
      const previousColumnId = card.column_id;
      stmts.moveKanbanCard.run(columnId, position ?? 0, req.params.cardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      const updatedCard = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow;
      res.json(updatedCard);

      try {
        const col = (
          stmts.getKanbanColumn as { get?: (id: string) => KanbanColumnRow | undefined }
        )?.get?.(columnId);

        if (col && previousColumnId !== columnId) {
          broadcast({
            type: 'card_moved',
            projectId: req.params.projectId,
            cardId: req.params.cardId,
            cardTitle: updatedCard.title,
            columnName: col.name,
            assignee: updatedCard.assignee,
            prUrl: updatedCard.pr_url,
          });
        }
        // Note: PR review is now triggered by the GitHub webhook handler
        // (pull_request.opened/synchronize) rather than by a card moving into
        // the Review column. The Review column is a UI signal only.
      } catch (err) {
        console.error(`[Card Move] Error in post-move hooks:`, (err as Error).message);
      }
    },
  );

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/assign',
    async (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      const { agentId } = req.body as { agentId?: string };
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });

      const found = findAgent(agentId);
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      const { agent } = found;

      const sessionId = crypto.randomUUID();
      const engine = agent.engine || 'claude-code';
      stmts.createSession.run(
        sessionId,
        agentId,
        card.title,
        engine,
        agent.model || defaultModelForEngine(engine),
        1,
        0,
      );

      const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
      let inProgressColumnId = card.column_id;
      if (board) {
        const cols = stmts.getKanbanColumns.all(board.id) as KanbanColumnRow[];
        const inProgress = cols.find((c) => c.name.toLowerCase() === 'in progress');
        if (inProgress) inProgressColumnId = inProgress.id;
      }

      stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        agent.name,
        card.labels,
        sessionId,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        req.params.cardId,
      );
      stmts.moveKanbanCard.run(inProgressColumnId, 0, req.params.cardId);

      const contextLines = [`# Task: ${card.title}`];
      if (card.description) contextLines.push(`\n## Description\n${card.description}`);
      if (card.priority) contextLines.push(`\n**Priority:** ${card.priority}`);
      if (card.labels) contextLines.push(`**Labels:** ${card.labels}`);
      if (card.github_issue_url) contextLines.push(`**GitHub:** ${card.github_issue_url}`);

      if (agent.role === 'intake') {
        contextLines.push(
          `\n---\n## Ticket Research & Breakdown`,
          `\nYou have been assigned this card for **research and ticket creation only** — do NOT write code or create PRs.`,
          `\nYour job:`,
          `1. **Research** this task — understand the scope, identify sub-tasks, and consider edge cases`,
          `2. **Check for duplicates** — before creating any new ticket, search the existing board to make sure a similar card doesn't already exist`,
          `3. **Break it down** into actionable sub-tickets on the kanban board (in Backlog)`,
          `4. **Link sub-tickets** to the same epic as this card (if it has one)${card.epic_id ? ` — epic ID: \`${card.epic_id}\`` : ''}`,
          `5. **Add a comment** to this card summarizing what you created`,
          `6. **Move this card to Done** when finished`,
          `\n### Duplicate Detection`,
          `Before creating each ticket, fetch all existing cards:`,
          `\`\`\`bash`,
          `curl -s http://localhost:3051/api/projects/${req.params.projectId}/board | jq '.cards[] | {id, title, description, column: .column_id}'`,
          `\`\`\``,
          `If a card with a similar title or overlapping scope already exists, skip creating a duplicate and note it in your summary comment.`,
          `\n### Card APIs`,
          `- **Get board**: \`GET /api/projects/${req.params.projectId}/board\``,
          `- **Create card**: \`POST /api/projects/${req.params.projectId}/board/cards\` with \`{title, description, priority, labels, columnId, createdBy: "${agent.id}"}\``,
          `- **Link to epic**: \`POST /api/projects/${req.params.projectId}/board/cards/:cardId/epic\` with \`{epicId}\``,
          `- **Add comment**: \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/comments\` with \`{content, author: "${agent.id}"}\``,
          `- **Move card**: \`POST /api/projects/${req.params.projectId}/board/cards/${req.params.cardId}/move\` with \`{columnId: "<done-column-id>"}\``,
        );
      } else {
        contextLines.push(
          `\n---\nYou have been assigned this task from the project kanban board. Review the description above and begin working on it. Update the kanban card with progress as you go.`,
        );
      }

      const contextMessage = contextLines.join('\n');

      handleChat(null, {
        type: 'chat',
        agentId,
        sessionId,
        content: contextMessage,
        hookSpecificOutput: { sessionTitle: card.title },
      }).catch((err: Error) => {
        console.error(`[Board Assign] handleChat failed for session ${sessionId}:`, err.message);
        broadcast({
          type: 'error',
          agentId,
          sessionId,
          message: `Failed to start agent session: ${err.message}`,
        });
      });

      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      broadcast({ type: 'session_created', agentId, session: stmts.getSession.get(sessionId) });

      res.json({
        sessionId,
        card: stmts.getKanbanCard.get(req.params.cardId),
      });
    },
  );

  // Clear assignee and any linked session from a card. Mirrors the POST
  // /assign endpoint so the UI has a symmetric action for unassigning.
  router.post(
    '/api/projects/:projectId/board/cards/:cardId/unassign',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      stmts.updateKanbanCard.run(
        card.title,
        card.description,
        card.priority,
        null,
        card.labels,
        null,
        card.github_issue_url,
        card.pr_url,
        card.epic_id,
        req.params.cardId,
      );

      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCard.get(req.params.cardId));
    },
  );

  router.delete('/api/projects/:projectId/board/cards/:cardId', (req: Request, res: Response) => {
    const cardId = req.params.cardId as string;

    const pending = pendingReviewComments.get(cardId);
    if (pending) {
      if ((pending as { timer?: ReturnType<typeof setTimeout> }).timer)
        clearTimeout((pending as { timer: ReturnType<typeof setTimeout> }).timer);
      pendingReviewComments.delete(cardId);
    }
    lastDispatchedReviewId.delete(cardId);

    stmts.deleteKanbanCard.run(cardId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.get('/api/projects/:projectId/board/undocumented', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
    if (!board) return res.json(null);
    const card = stmts.getNextUndocumentedCard.get(board.id);
    res.json(card || null);
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/documented',
    (req: Request, res: Response) => {
      stmts.markCardDocumented.run(req.params.cardId);
      res.json({ ok: true });
    },
  );

  router.get(
    '/api/projects/:projectId/board/cards/:cardId/comments',
    (req: Request, res: Response) => {
      res.json(stmts.getKanbanCardComments.all(req.params.cardId));
    },
  );

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/comments',
    (req: Request, res: Response) => {
      const { author, content } = req.body as { author?: string; content?: string };
      if (!author || !content)
        return res.status(400).json({ error: 'author and content are required' });
      const id = uuidv4();
      stmts.createKanbanCardComment.run(id, req.params.cardId, author, content);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCardComments.all(req.params.cardId));
    },
  );

  router.delete(
    '/api/projects/:projectId/board/cards/:cardId/comments/:commentId',
    (req: Request, res: Response) => {
      stmts.deleteKanbanCardComment.run(req.params.commentId);
      res.json({ ok: true });
    },
  );

  // ─── Card blockers ────────────────────────────────────────────────────
  //
  // Soft enforcement: the move endpoint does NOT gate on blocker state.
  // Clients show a confirm dialog; the autonomous dispatcher silently
  // skips blocked cards. See wiki (Kanban Blockers) for the product call.
  router.post(
    '/api/projects/:projectId/board/cards/:cardId/blockers',
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const { blockedByCardId } = req.body as { blockedByCardId?: string };
      const cardId = req.params.cardId as string;
      if (!blockedByCardId || typeof blockedByCardId !== 'string') {
        return res.status(400).json({ error: 'blockedByCardId is required' });
      }
      if (blockedByCardId === cardId) {
        return res.status(400).json({ error: 'A card cannot block itself' });
      }

      // Both cards must exist and belong to this project's board. That second
      // check keeps blocker edges scoped to one board — cross-project links
      // would silently break the GET /board enrichment.
      const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
      const other = stmts.getKanbanCard.get(blockedByCardId) as KanbanCardRow | undefined;
      if (!card || !other) return res.status(404).json({ error: 'Card not found' });
      const board = stmts.getKanbanBoard.get(req.params.projectId) as KanbanBoardRow | undefined;
      if (!board || card.board_id !== board.id || other.board_id !== board.id) {
        return res.status(404).json({ error: 'Card not found on this project board' });
      }

      // Duplicate check first — cheap and avoids walking the graph for a
      // link that's already there.
      const existing = stmts.getBlocker.get(cardId, blockedByCardId) as
        | KanbanCardBlockerRow
        | undefined;
      if (existing) return res.status(409).json({ error: 'duplicate' });

      // Cycle check: would adding (cardId → blockedByCardId) create a loop?
      // findCycle returns the path so the client can name the conflict.
      const cyclePath = findCycle(stmts, cardId, blockedByCardId);
      if (cyclePath) return res.status(409).json({ error: 'cycle', path: cyclePath });

      const id = uuidv4();
      stmts.createBlocker.run(id, cardId, blockedByCardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.status(201).json({
        id,
        card_id: cardId,
        blocked_by_card_id: blockedByCardId,
      });
    },
  );

  router.delete(
    '/api/projects/:projectId/board/cards/:cardId/blockers/:blockedByCardId',
    (req: Request, res: Response) => {
      const cardId = req.params.cardId as string;
      const blockedByCardId = req.params.blockedByCardId as string;
      const existing = stmts.getBlocker.get(cardId, blockedByCardId) as
        | KanbanCardBlockerRow
        | undefined;
      if (!existing) return res.status(404).json({ error: 'Blocker link not found' });
      stmts.deleteBlocker.run(cardId, blockedByCardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.status(204).end();
    },
  );

  router.get('/api/projects/:projectId/board/epics', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    res.json(stmts.getKanbanEpics.all(board.id));
  });

  router.post('/api/projects/:projectId/board/epics', (req: Request, res: Response) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId as string);
    const { name, description, color } = req.body as {
      name?: string;
      description?: string;
      color?: string;
    };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const epics = stmts.getKanbanEpics.all(board.id) as KanbanEpicRow[];
    const maxPos = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanEpic.run(id, board.id, name, description || null, color || '#6366F1', maxPos);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanEpic.get(id));
  });

  router.put('/api/projects/:projectId/board/epics/:epicId', (req: Request, res: Response) => {
    const epic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow | undefined;
    if (!epic) return res.status(404).json({ error: 'Epic not found' });
    const {
      name,
      description,
      color,
      autonomous,
      autonomousInterval,
      autonomousMaxConcurrent,
      autonomousMaxIterations,
    } = req.body as {
      name?: string;
      description?: string | null;
      color?: string;
      autonomous?: number;
      autonomousInterval?: number;
      autonomousMaxConcurrent?: number;
      autonomousMaxIterations?: number;
    };

    if (autonomous && !epic.autonomous) {
      const currentAutonomous = stmts.getAutonomousEpic.get(epic.board_id) as
        | KanbanEpicRow
        | undefined;
      if (currentAutonomous && currentAutonomous.id !== epic.id) {
        stmts.updateKanbanEpic.run(
          currentAutonomous.name,
          currentAutonomous.description,
          currentAutonomous.color,
          0,
          currentAutonomous.autonomous_interval,
          currentAutonomous.autonomous_max_concurrent,
          currentAutonomous.autonomous_max_iterations,
          currentAutonomous.id,
        );
      }
    }

    if (autonomous && !epic.autonomous) {
      const currentAutonomous2 = stmts.getAutonomousEpic.get(epic.board_id) as
        | KanbanEpicRow
        | undefined;
      if (currentAutonomous2 && currentAutonomous2.id !== epic.id) {
        scheduleAutonomousEpic(req.params.projectId as string, {
          ...currentAutonomous2,
          autonomous: 0,
        });
      }
    }

    stmts.updateKanbanEpic.run(
      name ?? epic.name,
      description ?? epic.description,
      color ?? epic.color,
      autonomous ?? epic.autonomous,
      autonomousInterval ?? epic.autonomous_interval,
      autonomousMaxConcurrent ?? epic.autonomous_max_concurrent,
      autonomousMaxIterations ?? epic.autonomous_max_iterations,
      req.params.epicId,
    );

    const updatedEpic = stmts.getKanbanEpic.get(req.params.epicId) as KanbanEpicRow;
    scheduleAutonomousEpic(req.params.projectId as string, updatedEpic);

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(updatedEpic);
  });

  router.delete('/api/projects/:projectId/board/epics/:epicId', (req: Request, res: Response) => {
    const epicCards = stmts.getKanbanCardsByEpic.all(req.params.epicId) as KanbanCardRow[];
    for (const card of epicCards) {
      stmts.updateKanbanCardEpic.run(null, card.id);
    }
    stmts.deleteKanbanEpic.run(req.params.epicId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  router.post(
    '/api/projects/:projectId/board/autonomous/run',
    async (req: Request, res: Response) => {
      try {
        await runAutonomousLoop(req.params.projectId as string);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.get('/api/projects/:projectId/board/autonomous/status', (req: Request, res: Response) => {
    const boardData = getOrCreateBoard(stmts, req.params.projectId as string);
    if (!boardData?.board) return res.json({ active: false });
    const epic = stmts.getAutonomousEpic.get(boardData.board.id) as KanbanEpicRow | undefined;
    if (!epic) return res.json({ active: false });

    const eligible = stmts.getEligibleAutonomousCards.all(
      epic.id,
      epic.autonomous_max_iterations,
    ) as KanbanCardRow[];
    const allEpicCards = stmts.getKanbanCardsByEpic.all(epic.id) as KanbanCardRow[];
    const cols = stmts.getKanbanColumns.all(boardData.board.id) as KanbanColumnRow[];
    const colNameMap = Object.fromEntries(cols.map((c) => [c.id, c.name]));
    const inProgress = allEpicCards.filter((c) => colNameMap[c.column_id] === 'In Progress');
    const inReview = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Review');
    const done = allEpicCards.filter((c) => colNameMap[c.column_id] === 'Done');
    const activeCards = inProgress.length + inReview.length;

    res.json({
      active: true,
      epicId: epic.id,
      epicName: epic.name,
      interval: epic.autonomous_interval,
      maxConcurrent: epic.autonomous_max_concurrent,
      maxIterations: epic.autonomous_max_iterations,
      eligibleCards: eligible.length,
      inProgressCards: inProgress.length,
      inReviewCards: inReview.length,
      activeCards,
      slotsAvailable: Math.max(0, epic.autonomous_max_concurrent - activeCards),
      doneCards: done.length,
      totalCards: allEpicCards.length,
      cronActive: autonomousCrons.has(epic.id),
    });
  });

  router.post(
    '/api/projects/:projectId/board/cards/:cardId/epic',
    (req: Request, res: Response) => {
      const card = stmts.getKanbanCard.get(req.params.cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });
      const { epicId } = req.body as { epicId?: string };
      stmts.updateKanbanCardEpic.run(epicId || null, req.params.cardId);
      broadcast({ type: 'kanban_update', projectId: req.params.projectId });
      res.json(stmts.getKanbanCard.get(req.params.cardId));
    },
  );

  // ─── Review Logs ─────────────────────────────────────────────────────
  router.get('/api/projects/:projectId/reviews', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const rows = stmts.getReviewLogs.all(req.params.projectId, limit);
    res.json(rows);
  });

  // Active review sessions are now driven by the Reviewer agent's regular
  // sessions list (sessions whose title starts with "Review: PR #..."). The
  // legacy in-memory tracking map is gone, so this endpoint reports them by
  // querying the sessions table for each Reviewer agent on the project.
  router.get('/api/projects/:projectId/reviews/active', (req: Request, res: Response) => {
    const project = deps.getProjects().find((p) => p.id === req.params.projectId);
    if (!project) return res.json([]);

    const reviewerIds = (project.agents || [])
      .filter((a) => a.role === 'reviewer')
      .map((a) => a.id);
    if (reviewerIds.length === 0) return res.json([]);

    type SessionLite = { id: string; agent_id: string; name: string };
    const active: Array<{
      sessionId: string;
      cardId: null;
      prUrl: null;
      cardTitle: string;
    }> = [];

    for (const reviewerId of reviewerIds) {
      const rows = (stmts.getSessions.all(reviewerId) || []) as SessionLite[];
      for (const s of rows) {
        if (s.name && s.name.startsWith('Review: PR #')) {
          active.push({ sessionId: s.id, cardId: null, prUrl: null, cardTitle: s.name });
        }
      }
    }
    res.json(active);
  });

  return router;
}

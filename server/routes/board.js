import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Router } from 'express';
import { defaultModelForEngine } from '../config.js';

export function getOrCreateBoard(stmts, projectId) {
  let board = stmts.getKanbanBoard.get(projectId);
  if (board) {
    return {
      board,
      columns: stmts.getKanbanColumns.all(board.id),
      cards: stmts.getKanbanCards.all(board.id),
      epics: stmts.getKanbanEpics.all(board.id),
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
  board = stmts.getKanbanBoardById.get(boardId);
  return {
    board,
    columns: stmts.getKanbanColumns.all(boardId),
    cards: [],
    epics: [],
  };
}

export default function createBoardRoutes(deps) {
  const {
    findProject,
    findAgent,
    broadcast,
    stmts,
    handleChat,
    triggerReviewForCard,
    pendingReviewComments,
    lastDispatchedReviewId,
    scheduleAutonomousEpic,
    autonomousCrons,
    runAutonomousLoop,
  } = deps;

  const router = Router();

  // GET board
  router.get('/api/projects/:projectId/board', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(getOrCreateBoard(stmts, req.params.projectId));
  });

  // POST column
  router.post('/api/projects/:projectId/board/columns', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { board, columns } = getOrCreateBoard(stmts, req.params.projectId);
    const maxPos = columns.length > 0 ? Math.max(...columns.map((c) => c.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanColumn.run(id, board.id, name, maxPos, color || null);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanColumns.all(board.id));
  });

  // PUT column
  router.put('/api/projects/:projectId/board/columns/:columnId', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, position, color } = req.body;
    stmts.updateKanbanColumn.run(name, position, color || null, req.params.columnId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  // DELETE column
  router.delete('/api/projects/:projectId/board/columns/:columnId', (req, res) => {
    stmts.deleteKanbanColumn.run(req.params.columnId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  // GET cards
  router.get('/api/projects/:projectId/board/cards', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId);
    res.json(stmts.getKanbanCards.all(board.id));
  });

  // POST card
  router.post('/api/projects/:projectId/board/cards', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const {
      title,
      description,
      priority,
      assignee,
      labels,
      columnId,
      sessionId,
      githubIssueUrl,
      createdBy,
    } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    const { board } = getOrCreateBoard(stmts, req.params.projectId);
    const existingCards = stmts.getKanbanCardsByColumn.all(columnId);
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

  // PUT card
  router.put('/api/projects/:projectId/board/cards/:cardId', (req, res) => {
    const card = stmts.getKanbanCard.get(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const {
      title,
      description,
      priority,
      assignee,
      labels,
      sessionId,
      githubIssueUrl,
      prUrl,
      epicId,
    } = req.body;
    stmts.updateKanbanCard.run(
      title ?? card.title,
      description ?? card.description,
      priority ?? card.priority,
      assignee ?? card.assignee,
      labels ?? card.labels,
      sessionId ?? card.session_id,
      githubIssueUrl ?? card.github_issue_url,
      prUrl ?? card.pr_url,
      epicId ?? card.epic_id,
      req.params.cardId,
    );
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCard.get(req.params.cardId));
  });

  // POST move card
  router.post('/api/projects/:projectId/board/cards/:cardId/move', (req, res) => {
    const card = stmts.getKanbanCard.get(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const { columnId, position } = req.body;
    if (!columnId) return res.status(400).json({ error: 'columnId is required' });
    stmts.moveKanbanCard.run(columnId, position ?? 0, req.params.cardId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    const updatedCard = stmts.getKanbanCard.get(req.params.cardId);
    res.json(updatedCard);

    // Review-column trigger
    try {
      const col = stmts.getKanbanColumn?.get(columnId);
      if (col && col.name.toLowerCase() === 'review') {
        console.log(
          `[Lead Review] Card "${updatedCard.title}" moved to Review column — checking for review trigger`,
        );
        const project = findProject(req.params.projectId);
        if (project) {
          triggerReviewForCard(req.params.cardId, project);
        } else {
          console.log(`[Lead Review] No project found for ${req.params.projectId} — skipping`);
        }
      }
    } catch (err) {
      console.error(`[Lead Review] Error in review-column trigger:`, err.message);
    }
  });

  // POST assign card
  router.post('/api/projects/:projectId/board/cards/:cardId/assign', async (req, res) => {
    const card = stmts.getKanbanCard.get(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    const { agentId } = req.body;
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
      defaultModelForEngine(engine),
      1,
      0,
    );

    const board = stmts.getKanbanBoard.get(req.params.projectId);
    let inProgressColumnId = card.column_id;
    if (board) {
      const cols = stmts.getKanbanColumns.all(board.id);
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
    contextLines.push(
      `\n---\nYou have been assigned this task from the project kanban board. Review the description above and begin working on it. Update the kanban card with progress as you go.`,
    );

    const contextMessage = contextLines.join('\n');

    handleChat(null, { agentId, sessionId, content: contextMessage });

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    broadcast({ type: 'session_created', agentId, session: stmts.getSession.get(sessionId) });

    res.json({
      sessionId,
      card: stmts.getKanbanCard.get(req.params.cardId),
    });
  });

  // DELETE card
  router.delete('/api/projects/:projectId/board/cards/:cardId', (req, res) => {
    const cardId = req.params.cardId;

    const pending = pendingReviewComments.get(cardId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pendingReviewComments.delete(cardId);
    }
    lastDispatchedReviewId.delete(cardId);

    stmts.deleteKanbanCard.run(cardId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  // GET undocumented
  router.get('/api/projects/:projectId/board/undocumented', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const board = stmts.getKanbanBoard.get(req.params.projectId);
    if (!board) return res.json(null);
    const card = stmts.getNextUndocumentedCard.get(board.id);
    res.json(card || null);
  });

  // POST documented
  router.post('/api/projects/:projectId/board/cards/:cardId/documented', (req, res) => {
    stmts.markCardDocumented.run(req.params.cardId);
    res.json({ ok: true });
  });

  // GET comments
  router.get('/api/projects/:projectId/board/cards/:cardId/comments', (req, res) => {
    res.json(stmts.getKanbanCardComments.all(req.params.cardId));
  });

  // POST comment
  router.post('/api/projects/:projectId/board/cards/:cardId/comments', (req, res) => {
    const { author, content } = req.body;
    if (!author || !content)
      return res.status(400).json({ error: 'author and content are required' });
    const id = uuidv4();
    stmts.createKanbanCardComment.run(id, req.params.cardId, author, content);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCardComments.all(req.params.cardId));
  });

  // DELETE comment
  router.delete('/api/projects/:projectId/board/cards/:cardId/comments/:commentId', (req, res) => {
    stmts.deleteKanbanCardComment.run(req.params.commentId);
    res.json({ ok: true });
  });

  // GET epics
  router.get('/api/projects/:projectId/board/epics', (req, res) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId);
    res.json(stmts.getKanbanEpics.all(board.id));
  });

  // POST epic
  router.post('/api/projects/:projectId/board/epics', (req, res) => {
    const { board } = getOrCreateBoard(stmts, req.params.projectId);
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const epics = stmts.getKanbanEpics.all(board.id);
    const maxPos = epics.length > 0 ? Math.max(...epics.map((e) => e.position)) + 1 : 0;
    const id = uuidv4();
    stmts.createKanbanEpic.run(id, board.id, name, description || null, color || '#6366F1', maxPos);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanEpic.get(id));
  });

  // PUT epic
  router.put('/api/projects/:projectId/board/epics/:epicId', (req, res) => {
    const epic = stmts.getKanbanEpic.get(req.params.epicId);
    if (!epic) return res.status(404).json({ error: 'Epic not found' });
    const {
      name,
      description,
      color,
      autonomous,
      autonomousInterval,
      autonomousMaxConcurrent,
      autonomousMaxIterations,
    } = req.body;

    if (autonomous && !epic.autonomous) {
      const currentAutonomous = stmts.getAutonomousEpic.get(epic.board_id);
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
      const currentAutonomous2 = stmts.getAutonomousEpic.get(epic.board_id);
      if (currentAutonomous2 && currentAutonomous2.id !== epic.id) {
        scheduleAutonomousEpic(req.params.projectId, { ...currentAutonomous2, autonomous: 0 });
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

    const updatedEpic = stmts.getKanbanEpic.get(req.params.epicId);
    scheduleAutonomousEpic(req.params.projectId, updatedEpic);

    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(updatedEpic);
  });

  // DELETE epic
  router.delete('/api/projects/:projectId/board/epics/:epicId', (req, res) => {
    const epicCards = stmts.getKanbanCardsByEpic.all(req.params.epicId);
    for (const card of epicCards) {
      stmts.updateKanbanCardEpic.run(null, card.id);
    }
    stmts.deleteKanbanEpic.run(req.params.epicId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json({ ok: true });
  });

  // POST autonomous run
  router.post('/api/projects/:projectId/board/autonomous/run', async (req, res) => {
    try {
      await runAutonomousLoop(req.params.projectId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET autonomous status
  router.get('/api/projects/:projectId/board/autonomous/status', (req, res) => {
    const boardData = getOrCreateBoard(stmts, req.params.projectId);
    if (!boardData?.board) return res.json({ active: false });
    const epic = stmts.getAutonomousEpic.get(boardData.board.id);
    if (!epic) return res.json({ active: false });

    const eligible = stmts.getEligibleAutonomousCards.all(epic.id, epic.autonomous_max_iterations);
    const allEpicCards = stmts.getKanbanCardsByEpic.all(epic.id);
    const cols = stmts.getKanbanColumns.all(boardData.board.id);
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

  // POST card epic assignment
  router.post('/api/projects/:projectId/board/cards/:cardId/epic', (req, res) => {
    const card = stmts.getKanbanCard.get(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const { epicId } = req.body;
    stmts.updateKanbanCardEpic.run(epicId || null, req.params.cardId);
    broadcast({ type: 'kanban_update', projectId: req.params.projectId });
    res.json(stmts.getKanbanCard.get(req.params.cardId));
  });

  return router;
}

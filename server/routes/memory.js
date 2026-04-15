import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { runWikiMemorySync } from '../heartbeat.js';
import { stmts } from '../db.js';
import { findProject } from '../project-model.js';
import { defaultModelForEngine } from '../config.js';

/**
 * Build the prompt for note processing based on the target type.
 */
export function buildNoteProcessingPrompt(noteContent, noteDate, target, projectName) {
  const baseContext = [
    `You are processing a daily note from the "${projectName}" project, dated ${noteDate}.`,
    'Your job is to extract valuable knowledge from this note and incorporate it into the appropriate project knowledge store.',
    '',
    '## Note Content',
    '```',
    noteContent,
    '```',
    '',
  ];

  const targetInstructions = {
    auto: [
      '## Instructions',
      'Analyze this note and decide the best way to preserve its knowledge:',
      '1. **Wiki** — If it contains architecture decisions, API docs, conventions, or reusable knowledge, create or update a wiki page.',
      '   Use: `POST /api/projects/{projectId}/wiki` or `PUT /api/projects/{projectId}/wiki/{slug}`',
      '2. **Memory** — If it contains key decisions, preferences, or important facts that should persist in long-term memory, update MEMORY.md.',
      '3. **Both** — If the note contains both reusable documentation AND key facts, update both.',
      '4. **Skip** — If the note is purely ephemeral (status updates, chat logs with no lasting value), respond with "NO_ACTION_NEEDED" and explain why.',
      '',
      'After processing, respond with a brief summary of what you did (which wiki pages created/updated, what memory facts added, etc.).',
    ],
    wiki: [
      '## Instructions',
      'Extract knowledge from this note and create or update wiki pages.',
      'Use the wiki API to search for existing pages and create/update as needed:',
      '- `GET /api/projects/{projectId}/wiki?q=<search>` to find existing pages',
      '- `POST /api/projects/{projectId}/wiki` with `{title, content, category, updatedBy: "note-processor"}` to create',
      '- `PUT /api/projects/{projectId}/wiki/{slug}` to update existing pages',
      '',
      'Categories: general, api-docs, architecture, conventions, test-patterns, troubleshooting, onboarding',
      '',
      'After processing, respond with a summary of what wiki pages were created or updated.',
    ],
    memory: [
      '## Instructions',
      'Extract key decisions, facts, and preferences from this note and update MEMORY.md.',
      'Read the current MEMORY.md, identify what new facts from the note should be preserved,',
      'and write an updated version. Be conservative — only add facts that have lasting value.',
      '',
      'After processing, respond with a summary of what was added to MEMORY.md.',
    ],
    plan: [
      '## Instructions',
      'Extract actionable items from this note and create kanban cards for them.',
      'Use the kanban API:',
      '- `GET /api/projects/{projectId}/board` to see the board structure',
      '- `POST /api/projects/{projectId}/board/cards` with `{title, description, columnId, priority}` to create cards',
      '',
      'Create cards in the "Backlog" or "To Do" column as appropriate.',
      'Set priority based on urgency indicators in the note.',
      '',
      'After processing, respond with a summary of what cards were created.',
    ],
  };

  return [...baseContext, ...(targetInstructions[target] || targetInstructions.auto)].join('\n');
}

export default function createMemoryRoutes(routeDeps = {}) {
  const router = Router();
  const { handleChat } = routeDeps;

  // ── Manual trigger for wiki → memory reconciliation ──────────────
  router.post('/api/memory/reconcile', (_req, res) => {
    res.json({ status: 'running' });
    runWikiMemorySync().catch((err) => {
      console.error('[Wiki→Memory Sync] Manual trigger failed:', err.message);
    });
  });

  // ── Process a daily note through an agent ────────────────────────
  // POST /api/projects/:projectId/notes/:date/process
  // Body: { target: 'auto' | 'wiki' | 'memory' | 'plan', excerpt?: string }
  router.post('/api/projects/:projectId/notes/:date/process', (req, res) => {
    const { projectId, date } = req.params;
    const { target = 'auto', excerpt } = req.body;

    // Validate target
    const validTargets = ['auto', 'wiki', 'memory', 'plan'];
    if (!validTargets.includes(target)) {
      return res
        .status(400)
        .json({ error: `Invalid target: ${target}. Must be one of: ${validTargets.join(', ')}` });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    // Find the project
    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    // Read the note content
    const notePath = path.join(project.ahw, 'memory', `${date}.md`);
    if (!existsSync(notePath)) {
      return res.status(404).json({ error: `No note found for date: ${date}` });
    }

    let noteContent;
    try {
      noteContent = readFileSync(notePath, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `Failed to read note: ${err.message}` });
    }

    if (!noteContent.trim()) {
      return res.status(400).json({ error: 'Note is empty' });
    }

    // Use excerpt if provided, otherwise use full note
    const contentToProcess = excerpt || noteContent;

    // Find the docs agent for this project
    const docsAgent = project.agents?.find((a) => a.role === 'docs');
    if (!docsAgent) {
      return res.status(404).json({
        error: 'No docs agent found for this project. A docs agent is required to process notes.',
      });
    }

    // Build the prompt
    const prompt = buildNoteProcessingPrompt(contentToProcess, date, target, project.name);

    // Create processing record + session
    const processingId = uuidv4();
    const sessionId = uuidv4();
    const engine = docsAgent.engine || 'claude-code';
    const model = docsAgent.model || defaultModelForEngine(engine);
    const sessionName = `[Note] ${date} → ${target}`;

    // Create session for the background task
    stmts.createSession.run(sessionId, docsAgent.id, sessionName, engine, model, 1, 0);

    // Create background task record
    const taskId = uuidv4();
    stmts.insertBackgroundTask.run(taskId, sessionId, docsAgent.id, prompt);

    // Create note processing record
    const noteExcerpt = contentToProcess.substring(0, 200);
    stmts.createNoteProcessing.run(processingId, projectId, date, noteExcerpt, target, sessionId);

    // Return immediately with the processing record
    const processing = stmts.getNoteProcessing.get(processingId);
    res.status(201).json(processing);

    // Fire processing asynchronously
    setImmediate(() => {
      try {
        stmts.updateNoteProcessingStatus.run('running', processingId);

        if (!handleChat) {
          console.error('[Note Processing] handleChat not available');
          stmts.updateNoteProcessing.run(
            'error',
            JSON.stringify({ error: 'handleChat not available' }),
            processingId,
          );
          return;
        }

        // Fire handleChat with ws=null (same pattern as POST /api/tasks)
        handleChat(null, {
          agentId: docsAgent.id,
          sessionId,
          content: prompt,
        });
      } catch (err) {
        console.error('[Note Processing] Failed to start:', err.message);
        stmts.updateNoteProcessing.run(
          'error',
          JSON.stringify({ error: err.message }),
          processingId,
        );
      }
    });
  });

  // ── Get processings for a project ────────────────────────────────
  // GET /api/projects/:projectId/notes/processings?limit=50
  router.get('/api/projects/:projectId/notes/processings', (req, res) => {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const processings = stmts.getNoteProcessingsByProject.all(projectId, limit);
    res.json(processings);
  });

  // ── Get processings for a specific date ──────────────────────────
  // GET /api/projects/:projectId/notes/:date/processings
  // Note: safe from collision with /notes/processings above because that literal
  // route is registered first, and this route validates :date as YYYY-MM-DD.
  router.get('/api/projects/:projectId/notes/:date/processings', (req, res) => {
    const { projectId, date } = req.params;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const processings = stmts.getNoteProcessingsByDate.all(projectId, date);
    res.json(processings);
  });

  // ── Get a single processing by ID ────────────────────────────────
  // GET /api/projects/:projectId/notes/processings/:processingId
  router.get('/api/projects/:projectId/notes/processings/:processingId', (req, res) => {
    const { processingId } = req.params;

    const processing = stmts.getNoteProcessing.get(processingId);
    if (!processing) {
      return res.status(404).json({ error: 'Processing not found' });
    }

    res.json(processing);
  });

  return router;
}

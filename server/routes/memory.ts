import { v4 as uuidv4 } from 'uuid';
import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { runWikiMemorySync } from '../heartbeat.js';
import { stmts } from '../db.js';
import { findProject } from '../project-model.js';
import { defaultModelForEngine } from '../config.js';
import type { RouteDeps, NoteProcessingRow } from '../types.js';
import { setSessionOwner, resolveOwnerUserId } from '../session-ownership.js';
import type { AuthenticatedRequest } from '../auth.js';

type NoteTarget = 'auto' | 'wiki' | 'memory' | 'plan';

export function buildNoteProcessingPrompt(
  noteContent: string,
  noteDate: string,
  target: NoteTarget,
  projectName: string,
): string {
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

  const targetInstructions: Record<string, string[]> = {
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
      'Create cards in the "To Do" column.',
      'Set priority based on urgency indicators in the note.',
      '',
      'After processing, respond with a summary of what cards were created.',
    ],
  };

  return [...baseContext, ...(targetInstructions[target] || targetInstructions.auto)].join('\n');
}

export default function createMemoryRoutes(routeDeps: RouteDeps = {} as RouteDeps): Router {
  const router = Router();
  const { handleChat } = routeDeps;

  router.post('/api/memory/reconcile', (_req: Request, res: Response) => {
    res.json({ status: 'running' });
    runWikiMemorySync().catch((err: Error) => {
      console.error('[Wiki→Memory Sync] Manual trigger failed:', err.message);
    });
  });

  router.post('/api/projects/:projectId/notes/:date/process', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const date = req.params.date as string;
    const { target = 'auto', excerpt } = req.body;

    const validTargets: NoteTarget[] = ['auto', 'wiki', 'memory', 'plan'];
    if (!validTargets.includes(target)) {
      return res
        .status(400)
        .json({ error: `Invalid target: ${target}. Must be one of: ${validTargets.join(', ')}` });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const notePath = path.join(project.ahw, 'memory', `${date}.md`);
    if (!existsSync(notePath)) {
      return res.status(404).json({ error: `No note found for date: ${date}` });
    }

    let noteContent: string;
    try {
      noteContent = readFileSync(notePath, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `Failed to read note: ${(err as Error).message}` });
    }

    if (!noteContent.trim()) {
      return res.status(400).json({ error: 'Note is empty' });
    }

    const contentToProcess = excerpt || noteContent;

    const docsAgent = project.agents?.find((a) => a.role === 'docs');
    if (!docsAgent) {
      return res.status(404).json({
        error: 'No docs agent found for this project. A docs agent is required to process notes.',
      });
    }

    const prompt = buildNoteProcessingPrompt(
      contentToProcess,
      date,
      target as NoteTarget,
      project.name,
    );

    const processingId = uuidv4();
    const sessionId = uuidv4();
    const engine = docsAgent.engine || 'claude-code';
    const model = docsAgent.model || defaultModelForEngine(engine);
    const sessionName = `[Note] ${date} → ${target}`;

    stmts!.createSession.run(sessionId, docsAgent.id, sessionName, engine, model, 1, 0, 1);
    setSessionOwner(sessionId, resolveOwnerUserId(req as AuthenticatedRequest));

    const taskId = uuidv4();
    stmts!.insertBackgroundTask.run(taskId, sessionId, docsAgent.id, prompt);

    const noteExcerpt = contentToProcess.substring(0, 200);
    stmts!.createNoteProcessing.run(processingId, projectId, date, noteExcerpt, target, sessionId);

    const processing = stmts!.getNoteProcessing.get(processingId) as NoteProcessingRow;
    res.status(201).json(processing);

    setImmediate(() => {
      try {
        stmts!.updateNoteProcessingStatus.run('running', processingId);

        if (!handleChat) {
          console.error('[Note Processing] handleChat not available');
          stmts!.updateNoteProcessing.run(
            'error',
            JSON.stringify({ error: 'handleChat not available' }),
            processingId,
          );
          return;
        }

        handleChat(null, {
          type: 'chat',
          agentId: docsAgent.id,
          sessionId,
          content: prompt,
        });
      } catch (err) {
        console.error('[Note Processing] Failed to start:', (err as Error).message);
        stmts!.updateNoteProcessing.run(
          'error',
          JSON.stringify({ error: (err as Error).message }),
          processingId,
        );
      }
    });
  });

  router.get('/api/projects/:projectId/notes/processings', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const processings = stmts!.getNoteProcessingsByProject.all(
      projectId,
      limit,
    ) as NoteProcessingRow[];
    res.json(processings);
  });

  router.get('/api/projects/:projectId/notes/:date/processings', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const date = req.params.date as string;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    const project = findProject(projectId);
    if (!project) {
      return res.status(404).json({ error: `Project not found: ${projectId}` });
    }

    const processings = stmts!.getNoteProcessingsByDate.all(projectId, date) as NoteProcessingRow[];
    res.json(processings);
  });

  router.get(
    '/api/projects/:projectId/notes/processings/:processingId',
    (req: Request, res: Response) => {
      const processingId = req.params.processingId as string;

      const processing = stmts!.getNoteProcessing.get(processingId) as
        | NoteProcessingRow
        | undefined;
      if (!processing) {
        return res.status(404).json({ error: 'Processing not found' });
      }

      res.json(processing);
    },
  );

  return router;
}

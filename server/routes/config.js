import { Router } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

export default function createConfigRoutes(deps) {
  const {
    stmts,
    getProjects,
    setProjects,
    saveProjects,
    config,
    getGhBotUser,
    setGhBotUser,
    serverDir,
  } = deps;
  const router = Router();

  // GET /api/config
  router.get('/api/config', (_req, res) => {
    let fileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(path.join(config.dataDir, 'config.json'), 'utf-8'));
    } catch {
      /* no file yet */
    }
    res.json({
      claudeBin: config.claudeBin,
      cursorBin: config.cursorBin,
      defaultModel: config.defaultModel,
      defaultCwd: config.defaultCwd,
      port: config.port,
      publicUrl: config.publicUrl || '',
      apiKey: config.apiKey || '',
      authRequired: !!config.apiKey,
      botGithubToken: config.botGithubToken ? '••••••••' : '',
      botGithubTokenSet: !!config.botGithubToken,
      botGithubUser: getGhBotUser() || null,
      _file: {
        claudeBin: fileConfig.claudeBin || null,
        cursorBin: fileConfig.cursorBin || null,
      },
    });
  });

  // GET /api/config/models — valid models per engine (for UI dropdowns)
  router.get('/api/config/models', (_req, res) => {
    res.json({
      defaultModel: config.defaultModel,
      engineDefaultModels: config.engineDefaultModels,
      engineValidModels: config.engineValidModels,
    });
  });

  // PATCH /api/config
  router.patch('/api/config', (req, res) => {
    const allowed = [
      'claudeBin',
      'cursorBin',
      'defaultModel',
      'defaultCwd',
      'port',
      'apiKey',
      'publicUrl',
      'botGithubToken',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid config fields provided' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }

    Object.assign(fileConfig, updates);
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    for (const [key, val] of Object.entries(updates)) {
      if (key in config) config[key] = val;
    }

    if ('botGithubToken' in updates) {
      const execAsync = promisify(exec);
      const newToken = updates.botGithubToken;
      if (newToken) {
        execAsync('gh api user --jq ".login"', { env: { ...process.env, GH_TOKEN: newToken } })
          .then(({ stdout }) => {
            setGhBotUser(stdout.trim());
            console.log(`[GitHub Bot] Bot account re-detected: ${stdout.trim()}`);
          })
          .catch((err) => {
            setGhBotUser(null);
            console.warn(`[GitHub Bot] Token validation failed: ${err.message?.split('\n')[0]}`);
          });
      } else {
        setGhBotUser(null);
        console.log('[GitHub Bot] Bot token removed');
      }
    }

    res.json({
      ok: true,
      updated: Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [k, k === 'botGithubToken' && v ? '••••••••' : v]),
      ),
    });
  });

  // GET /api/projects/:projectId/export
  router.get('/api/projects/:projectId/export', (req, res) => {
    try {
      const projects = getProjects();
      const project = projects.find((p) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const allCrons = stmts.getCrons.all();
      const projectCrons = allCrons
        .filter((c) => c.cwd === project.cwd)
        .map(
          ({
            last_run: _last_run,
            last_result: _last_result,
            next_run_at: _next_run_at,
            ...rest
          }) => rest,
        );

      const allRooms = stmts.getRooms.all();
      const projectRooms = allRooms
        .filter((r) => r.project_id === project.id)
        .map((room) => {
          const roomAgents = stmts.getRoomAgents.all(room.id).map((ra) => ({
            agentId: ra.agent_id,
            position: ra.position,
          }));
          return { ...room, agents: roomAgents };
        });

      const webhooks = stmts.getWebhookConfigsByProject
        .all(project.id)
        .map(({ secret: _secret, ...rest }) => ({ ...rest, secret: '***REDACTED***' }));

      const wikiPages = stmts.getWikiPages.all(project.id).map((page) => {
        const full = stmts.getWikiPage.get(project.id, page.slug);
        return full || page;
      });

      let kanban = null;
      const board = stmts.getKanbanBoard.get(project.id);
      if (board) {
        const columns = stmts.getKanbanColumns.all(board.id);
        const cards = stmts.getKanbanCards
          .all(board.id)
          .map(({ session_id: _session_id, ...rest }) => rest);
        const epics = stmts.getKanbanEpics.all(board.id);
        const comments = {};
        for (const card of cards) {
          const cardComments = stmts.getKanbanCardComments?.all(card.id);
          if (cardComments?.length) comments[card.id] = cardComments;
        }
        kanban = { board, columns, cards, epics, comments };
      }

      const exported = {
        version: 3,
        type: 'project',
        exportedAt: new Date().toISOString(),
        project,
        crons: projectCrons,
        rooms: projectRooms,
        webhooks,
        wiki: wikiPages,
        kanban,
      };

      const safeName = project.name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}-export-${new Date().toISOString().split('T')[0]}.json"`,
      );
      res.json(exported);
    } catch (err) {
      console.error('Project export failed:', err.message);
      res.status(500).json({ error: 'Export failed: ' + err.message });
    }
  });

  // POST /api/projects/:projectId/import
  router.post('/api/projects/:projectId/import', (req, res) => {
    try {
      const data = req.body;
      if (!data || data.version !== 3 || data.type !== 'project') {
        return res
          .status(400)
          .json({ error: 'Invalid project export — expected version 3 with type "project"' });
      }

      const targetProjectId = req.params.projectId;
      const projects = getProjects();
      const targetProject = projects.find((p) => p.id === targetProjectId);
      if (!targetProject) return res.status(404).json({ error: 'Target project not found' });

      const results = {
        project: false,
        crons: false,
        rooms: false,
        webhooks: false,
        wiki: false,
        kanban: false,
      };

      // 1. Update project config
      if (data.project) {
        targetProject.agents = data.project.agents || targetProject.agents;
        targetProject.color = data.project.color || targetProject.color;
        targetProject.leadAgent = data.project.leadAgent || targetProject.leadAgent;
        targetProject.subAgents = data.project.subAgents || targetProject.subAgents;
        if (data.project.commands) targetProject.commands = data.project.commands;
        saveProjects();
        results.project = true;
      }

      // 2. Crons — merge by name, set cwd to target project
      if (Array.isArray(data.crons)) {
        const existingCrons = stmts.getCrons.all();
        const existingNames = new Set(existingCrons.map((c) => c.name));
        let imported = 0;
        for (const c of data.crons) {
          if (existingNames.has(c.name)) continue;
          stmts.createCron.run(
            c.name,
            c.schedule,
            c.prompt,
            targetProject.cwd,
            c.enabled !== undefined ? (c.enabled ? 1 : 0) : 1,
          );
          imported++;
        }
        results.crons = `${imported} new, ${data.crons.length - imported} skipped`;
      }

      // 3. Rooms — merge by name, link to target project
      if (Array.isArray(data.rooms)) {
        const existingRooms = stmts.getRooms.all();
        const existingNames = new Set(existingRooms.map((r) => r.name));
        let imported = 0;
        for (const r of data.rooms) {
          if (existingNames.has(r.name)) continue;
          const roomId = uuidv4();
          stmts.createProjectRoom.run(roomId, r.name, targetProjectId);
          if (r.max_turns) stmts.updateRoomMaxTurns.run(r.max_turns, roomId);
          if (Array.isArray(r.agents)) {
            for (const ra of r.agents) {
              stmts.addRoomAgent.run(roomId, ra.agentId || ra.agent_id, roomId);
            }
          }
          imported++;
        }
        results.rooms = `${imported} new, ${data.rooms.length - imported} skipped`;
      }

      // 4. Webhooks — merge by repo_url (skip redacted secrets)
      if (Array.isArray(data.webhooks)) {
        const existing = stmts.getWebhookConfigsByProject.all(targetProjectId);
        const existingRepos = new Set(existing.map((w) => w.repo_url));
        let imported = 0;
        for (const w of data.webhooks) {
          if (existingRepos.has(w.repo_url)) continue;
          const secret = w.secret && !w.secret.includes('REDACTED') ? w.secret : uuidv4();
          stmts.createWebhookConfig.run(
            targetProjectId,
            w.repo_url,
            secret,
            w.events || '{}',
            w.enabled ? 1 : 0,
          );
          imported++;
        }
        results.webhooks = `${imported} new, ${data.webhooks.length - imported} skipped`;
      }

      // 5. Wiki — merge by slug
      if (Array.isArray(data.wiki)) {
        let imported = 0,
          updated = 0;
        for (const page of data.wiki) {
          const existing = stmts.getWikiPage.get(targetProjectId, page.slug);
          if (existing) {
            stmts.updateWikiPage.run(
              page.title,
              page.content,
              page.category || 'general',
              page.updated_by || 'import',
              targetProjectId,
              page.slug,
            );
            updated++;
          } else {
            stmts.createWikiPage.run(
              uuidv4(),
              targetProjectId,
              page.title,
              page.slug,
              page.content || '',
              page.category || 'general',
              page.updated_by || 'import',
            );
            imported++;
          }
        }
        results.wiki = `${imported} new, ${updated} updated`;
      }

      // 6. Kanban — create board if none exists, then merge epics, cards, and comments
      if (data.kanban) {
        let existingBoard = stmts.getKanbanBoard.get(targetProjectId);
        let boardId;
        let boardCreated = false;
        const colIdMap = {};

        if (existingBoard) {
          boardId = existingBoard.id;
          // Map existing columns by name for merging
          const existingCols = stmts.getKanbanColumns.all(boardId);
          for (const col of existingCols) {
            // Map imported column IDs to existing column IDs by name match
            const matchingImported = (data.kanban.columns || []).find(
              (c) => c.name.toLowerCase() === col.name.toLowerCase(),
            );
            if (matchingImported) colIdMap[matchingImported.id] = col.id;
          }
          // Create any columns that don't exist yet
          for (const col of data.kanban.columns || []) {
            if (!colIdMap[col.id]) {
              const newColId = uuidv4();
              colIdMap[col.id] = newColId;
              stmts.createKanbanColumn.run(
                newColId,
                boardId,
                col.name,
                col.position,
                col.color || null,
              );
            }
          }
        } else {
          boardId = uuidv4();
          stmts.createKanbanBoard.run(
            boardId,
            targetProjectId,
            data.kanban.board?.name || `${targetProject.name} Board`,
          );
          boardCreated = true;
          for (const col of data.kanban.columns || []) {
            const newColId = uuidv4();
            colIdMap[col.id] = newColId;
            stmts.createKanbanColumn.run(
              newColId,
              boardId,
              col.name,
              col.position,
              col.color || null,
            );
          }
        }

        // Epics — merge by name
        const epicIdMap = {};
        const existingEpics = stmts.getKanbanEpics.all(boardId);
        const existingEpicNames = new Set(existingEpics.map((e) => e.name.toLowerCase()));
        let epicsImported = 0;
        for (const epic of data.kanban.epics || []) {
          if (existingEpicNames.has(epic.name.toLowerCase())) {
            // Map to existing epic
            const existing = existingEpics.find(
              (e) => e.name.toLowerCase() === epic.name.toLowerCase(),
            );
            if (existing) epicIdMap[epic.id] = existing.id;
            continue;
          }
          const newEpicId = uuidv4();
          epicIdMap[epic.id] = newEpicId;
          stmts.createKanbanEpic.run(
            newEpicId,
            boardId,
            epic.name,
            epic.description || '',
            epic.color || '#6b7280',
            epic.position || 0,
          );
          epicsImported++;
        }

        // Cards — merge by title (skip duplicates)
        const existingCards = stmts.getKanbanCards.all(boardId);
        const existingCardTitles = new Set(existingCards.map((c) => c.title.toLowerCase()));
        let cardsImported = 0,
          cardsSkipped = 0;
        for (const card of data.kanban.cards || []) {
          if (existingCardTitles.has(card.title.toLowerCase())) {
            cardsSkipped++;
            continue;
          }
          const newCardId = uuidv4();
          const newColId = colIdMap[card.column_id];
          if (!newColId) continue;
          const newEpicId = card.epic_id ? epicIdMap[card.epic_id] || null : null;
          stmts.createKanbanCard.run(
            newCardId,
            newColId,
            boardId,
            card.title,
            card.description || '',
            card.priority || 'medium',
            card.assignee || '',
            card.labels || '',
            null,
            card.github_issue_url || null,
            card.created_by || 'import',
            card.position || 0,
          );
          if (newEpicId) {
            stmts.updateKanbanCard.run(
              card.title,
              card.description || '',
              card.priority || 'medium',
              card.labels || '',
              card.assignee || '',
              null,
              card.github_issue_url || null,
              card.pr_url || null,
              newEpicId,
              newCardId,
            );
          }
          // Import comments for this card
          const cardComments = data.kanban.comments?.[card.id];
          if (cardComments?.length) {
            for (const comment of cardComments) {
              stmts.createKanbanCardComment.run(
                uuidv4(),
                newCardId,
                comment.author || 'import',
                comment.content,
              );
            }
          }
          cardsImported++;
        }
        results.kanban = boardCreated
          ? `Board created with ${data.kanban.columns?.length || 0} columns, ${cardsImported} cards, ${epicsImported} epics`
          : `Merged: ${cardsImported} new cards, ${cardsSkipped} skipped, ${epicsImported} new epics`;
      }

      res.json({ message: 'Project import complete.', results });
    } catch (err) {
      console.error('Project import failed:', err.message);
      res.status(500).json({ error: 'Import failed: ' + err.message });
    }
  });

  // Legacy full-instance export (kept for backward compatibility)
  router.get('/api/config/export', (_req, res) => {
    try {
      let fileConfig = {};
      try {
        fileConfig = JSON.parse(readFileSync(path.join(config.dataDir, 'config.json'), 'utf-8'));
      } catch {
        /* no config.json yet */
      }

      const crons = stmts.getCrons
        .all()
        .map(
          ({
            last_run: _last_run,
            last_result: _last_result,
            next_run_at: _next_run_at,
            ...rest
          }) => rest,
        );

      const rooms = stmts.getRooms.all().map((room) => {
        const roomAgents = stmts.getRoomAgents.all(room.id).map((ra) => ({
          agentId: ra.agent_id,
          position: ra.position,
        }));
        return { ...room, agents: roomAgents };
      });

      let slackConfig = { accounts: [] };
      try {
        slackConfig = JSON.parse(readFileSync(path.join(serverDir, 'slack-config.json'), 'utf-8'));
        slackConfig.accounts = (slackConfig.accounts || []).map(
          ({ botToken, appToken, ...rest }) => ({
            ...rest,
            botToken: botToken ? '***REDACTED***' : undefined,
            appToken: appToken ? '***REDACTED***' : undefined,
          }),
        );
      } catch {
        /* no slack config */
      }

      const projects = getProjects();
      const exported = {
        version: 2,
        exportedAt: new Date().toISOString(),
        config: fileConfig,
        projects,
        crons,
        rooms,
        slack: slackConfig,
      };

      res.setHeader('Content-Disposition', 'attachment; filename="agent-hub-export.json"');
      res.json(exported);
    } catch (err) {
      console.error('Config export failed:', err.message);
      res.status(500).json({ error: 'Export failed: ' + err.message });
    }
  });

  // Legacy full-instance import (v1/v2)
  router.post('/api/config/import', (req, res) => {
    try {
      const data = req.body;
      if (!data || ![1, 2].includes(data.version)) {
        return res.status(400).json({ error: 'Invalid export format — expected version 1 or 2' });
      }

      const results = { config: false, projects: false, crons: false, rooms: false, slack: false };

      // 1. Config.json
      if (data.config && typeof data.config === 'object') {
        writeFileSync(
          path.join(config.dataDir, 'config.json'),
          JSON.stringify(data.config, null, 2) + '\n',
        );
        results.config = true;
      }

      // 2. Projects (v2) or legacy agents (v1)
      if (data.version === 2 && Array.isArray(data.projects) && data.projects.length > 0) {
        setProjects(data.projects);
        saveProjects();
        results.projects = true;
      } else if (data.version === 1 && Array.isArray(data.agents) && data.agents.length > 0) {
        // Legacy v1 import: wrap each agent in its own project
        setProjects(
          data.agents.map((a) => ({
            id: a.id,
            name: a.name || a.id,
            cwd: a.cwd || config.defaultCwd,
            ahw: a.workspace || '',
            color: a.color || '#6b7280',
            agents: [
              {
                id: a.id,
                name: a.name || a.id,
                engine: a.engine || 'claude-code',
                systemPrompt: a.systemPrompt || '',
                color: a.color || '#6b7280',
                heartbeat: a.heartbeat || { enabled: false, interval: '', prompt: '' },
              },
            ],
          })),
        );
        saveProjects();
        results.projects = 'imported from v1 agents format';
      }

      // 3. Crons — merge by name
      if (Array.isArray(data.crons)) {
        const existingCrons = stmts.getCrons.all();
        const existingNames = new Set(existingCrons.map((c) => c.name));
        let imported = 0;
        for (const c of data.crons) {
          if (existingNames.has(c.name)) continue;
          stmts.createCron.run(
            c.name,
            c.schedule,
            c.prompt,
            c.cwd || config.defaultCwd,
            c.enabled !== undefined ? (c.enabled ? 1 : 0) : 1,
          );
          imported++;
        }
        results.crons = `${imported} new, ${data.crons.length - imported} skipped (duplicate names)`;
      }

      // 4. Rooms — merge by name
      if (Array.isArray(data.rooms)) {
        const existingRooms = stmts.getRooms.all();
        const existingNames = new Set(existingRooms.map((r) => r.name));
        let imported = 0;
        for (const r of data.rooms) {
          if (existingNames.has(r.name)) continue;
          const roomId = r.id || uuidv4();
          stmts.createRoom.run(roomId, r.name);
          if (r.max_turns) stmts.updateRoomMaxTurns.run(r.max_turns, roomId);
          if (Array.isArray(r.agents)) {
            for (const ra of r.agents) {
              stmts.addRoomAgent.run(roomId, ra.agentId || ra.agent_id, roomId);
            }
          }
          imported++;
        }
        results.rooms = `${imported} new, ${data.rooms.length - imported} skipped (duplicate names)`;
      }

      // 5. Slack config — only overwrite if tokens are NOT redacted
      if (data.slack && Array.isArray(data.slack.accounts)) {
        const hasRealTokens = data.slack.accounts.some(
          (a) => a.botToken && !a.botToken.includes('REDACTED'),
        );
        if (hasRealTokens) {
          writeFileSync(
            path.join(serverDir, 'slack-config.json'),
            JSON.stringify(data.slack, null, 2) + '\n',
          );
          results.slack = true;
        } else {
          results.slack = 'skipped (tokens redacted — update slack-config.json manually)';
        }
      }

      res.json({
        message: 'Import complete. Restart the server for all changes to take effect.',
        results,
      });
    } catch (err) {
      console.error('Config import failed:', err.message);
      res.status(500).json({ error: 'Import failed: ' + err.message });
    }
  });

  return router;
}

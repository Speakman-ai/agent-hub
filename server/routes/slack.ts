/**
 * Slack Bot Management API
 *
 * CRUD routes for DB-backed Slack bot configurations plus a test-connection
 * endpoint. These complement the file-backed slack-config.json approach by
 * allowing bots to be managed entirely from the UI.
 *
 * Endpoints:
 *   GET    /api/slack/bots               — list all DB-backed bots (tokens masked)
 *   POST   /api/slack/bots               — create a new bot config
 *   PUT    /api/slack/bots/:id           — update a bot config
 *   DELETE /api/slack/bots/:id           — delete a bot config + restart bots
 *   POST   /api/slack/bots/:id/test      — test token validity (auth.test)
 *   POST   /api/slack/bots/:id/toggle    — enable/disable a bot
 *   GET    /api/slack/status             — existing status (live connection state)
 *   POST   /api/slack/restart            — existing restart
 *   GET    /api/slack/messages           — existing message history
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { RouteDeps, SlackBotRow } from '../types.js';
import { restartSlack, getSlackStatus, getSlackMessages, getAllSlackMessages } from '../slack.js';

/** Mask tokens for API responses — show prefix + trailing chars only. */
function maskToken(token: string): string {
  if (!token || token === 'PLACEHOLDER') return token;
  // e.g. "xoxb-1234567890-..." → "xoxb-****…-ab12"
  const parts = token.split('-');
  if (parts.length < 2) {
    return token.substring(0, 6) + '****' + token.slice(-4);
  }
  const prefix = parts[0];
  return `${prefix}-****…-${token.slice(-6)}`;
}

function maskedBot(bot: SlackBotRow) {
  return {
    ...bot,
    bot_token: maskToken(bot.bot_token),
    app_token: maskToken(bot.app_token),
    channel_map: (() => {
      try {
        return JSON.parse(bot.channel_map);
      } catch {
        return {};
      }
    })(),
  };
}

export default function createSlackRoutes(deps: RouteDeps) {
  const { stmts, allAgents } = deps;
  const router = Router();

  // ── List bots ──────────────────────────────────────────────────────────────
  router.get('/api/slack/bots', (_req: Request, res: Response) => {
    try {
      const bots = stmts.listSlackBots.all() as SlackBotRow[];
      res.json(bots.map(maskedBot));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Create bot ─────────────────────────────────────────────────────────────
  router.post('/api/slack/bots', async (req: Request, res: Response) => {
    const { name, bot_token, app_token, agent_id, channel_map = {}, enabled = true } = req.body;
    if (!name || !bot_token || !app_token || !agent_id) {
      return res
        .status(400)
        .json({ error: 'name, bot_token, app_token, and agent_id are required' });
    }
    const id = randomUUID();
    try {
      stmts.insertSlackBot.run(
        id,
        name.trim(),
        bot_token.trim(),
        app_token.trim(),
        agent_id.trim(),
        JSON.stringify(channel_map),
        enabled ? 1 : 0,
      );
      // Restart bots so the new one connects
      await restartSlack(allAgents(), stmts);
      const row = stmts.getSlackBot.get(id) as SlackBotRow;
      res.status(201).json(maskedBot(row));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Update bot ─────────────────────────────────────────────────────────────
  router.put('/api/slack/bots/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    const { name = existing.name, agent_id = existing.agent_id, channel_map, enabled } = req.body;

    // Only replace tokens if explicitly provided (non-empty, non-masked)
    let bot_token = existing.bot_token;
    let app_token = existing.app_token;
    if (req.body.bot_token && !req.body.bot_token.includes('****')) {
      bot_token = req.body.bot_token.trim();
    }
    if (req.body.app_token && !req.body.app_token.includes('****')) {
      app_token = req.body.app_token.trim();
    }

    try {
      stmts.updateSlackBot.run(
        name.trim(),
        bot_token,
        app_token,
        agent_id.trim(),
        JSON.stringify(channel_map !== undefined ? channel_map : JSON.parse(existing.channel_map)),
        enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        id,
      );
      await restartSlack(allAgents(), stmts);
      const row = stmts.getSlackBot.get(id) as SlackBotRow;
      res.json(maskedBot(row));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Toggle enabled ─────────────────────────────────────────────────────────
  router.post('/api/slack/bots/:id/toggle', async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    const newEnabled = existing.enabled ? 0 : 1;
    try {
      stmts.updateSlackBot.run(
        existing.name,
        existing.bot_token,
        existing.app_token,
        existing.agent_id,
        existing.channel_map,
        newEnabled,
        id,
      );
      await restartSlack(allAgents(), stmts);
      res.json({ id, enabled: newEnabled === 1 });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Delete bot ─────────────────────────────────────────────────────────────
  router.delete('/api/slack/bots/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    try {
      stmts.deleteSlackBot.run(id);
      await restartSlack(allAgents(), stmts);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Test connection ────────────────────────────────────────────────────────
  // Validates the bot token by calling Slack auth.test — does NOT require the
  // full Bolt app startup. Can be called with either the bot's id (uses stored
  // token) or with raw tokens in the body (for new-bot wizard before saving).
  router.post('/api/slack/bots/:id/test', async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    // Use stored token unless a fresh token was passed in body
    const botToken =
      req.body.bot_token && !req.body.bot_token.includes('****')
        ? req.body.bot_token.trim()
        : existing.bot_token;

    try {
      const slackRes = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${botToken}`,
        },
      });
      const data = (await slackRes.json()) as {
        ok: boolean;
        team?: string;
        user?: string;
        team_id?: string;
        user_id?: string;
        error?: string;
      };
      if (data.ok) {
        res.json({
          ok: true,
          team: data.team,
          user: data.user,
          team_id: data.team_id,
          user_id: data.user_id,
        });
      } else {
        res.status(400).json({ ok: false, error: data.error || 'auth.test failed' });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ── Test with raw tokens (for wizard pre-save) ─────────────────────────────
  router.post('/api/slack/test-tokens', async (req: Request, res: Response) => {
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: 'bot_token is required' });

    try {
      const slackRes = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${bot_token.trim()}`,
        },
      });
      const data = (await slackRes.json()) as {
        ok: boolean;
        team?: string;
        user?: string;
        team_id?: string;
        user_id?: string;
        error?: string;
      };
      if (data.ok) {
        res.json({
          ok: true,
          team: data.team,
          user: data.user,
          team_id: data.team_id,
          user_id: data.user_id,
        });
      } else {
        res.status(400).json({ ok: false, error: data.error || 'auth.test failed' });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // ── Existing endpoints (kept here for co-location; also registered in misc.ts) ──

  router.get('/api/slack/status', (_req: Request, res: Response) => {
    res.json(getSlackStatus());
  });

  router.post('/api/slack/restart', async (_req: Request, res: Response) => {
    try {
      await restartSlack(allAgents(), stmts);
      res.json({ ok: true, status: getSlackStatus() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/slack/messages', (req: Request, res: Response) => {
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    if (agentId) {
      res.json(getSlackMessages(agentId, limit));
    } else {
      res.json(getAllSlackMessages(limit));
    }
  });

  return router;
}

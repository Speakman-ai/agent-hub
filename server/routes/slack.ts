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
import { encryptSecret, decryptSecret } from '../pr-env-store.js';
import { requireRole } from '../roles.js';

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

/**
 * Decrypt a stored secret, falling back to the raw stored value when the
 * blob isn't in `iv:tag:ciphertext` shape. `slack_bots` is a brand-new
 * table in the PR introducing this module, so today every row is encrypted —
 * but a hand-inserted row (manual SQL fix-up, restored backup) wouldn't be,
 * and we'd rather mask a plaintext leftover than 500 the entire list/start
 * path. The fallback is intentionally narrow: only the malformed-blob
 * `Error` is swallowed — anything else (e.g. wrong key) re-throws so we
 * notice the failure in logs.
 */
function safeDecryptSecret(value: string): string {
  if (!value) return value;
  try {
    return decryptSecret(value);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('Malformed ciphertext blob')) return value;
    throw err;
  }
}

function maskedBot(bot: SlackBotRow) {
  return {
    ...bot,
    bot_token: maskToken(safeDecryptSecret(bot.bot_token)),
    app_token: maskToken(safeDecryptSecret(bot.app_token)),
    channel_map: (() => {
      try {
        return JSON.parse(bot.channel_map);
      } catch {
        return {};
      }
    })(),
  };
}

/**
 * Validate the `channel_map` payload from the client.
 *
 * Server contract: `Record<string, { label?: string; agentId?: string }>` —
 * `dbBotToAccount` (server/slack.ts) parses exactly this shape and silently
 * drops entries that don't expose an `agentId`. A client that sends a
 * second shape (e.g. flat `Record<string, string>`) would persist
 * successfully and then no-op on dispatch — silent regression. Reject up
 * front.
 *
 * Returns `null` on success; an error string on failure.
 */
function validateChannelMap(value: unknown): string | null {
  if (value === undefined || value === null) return null; // optional → allow
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'channel_map must be an object keyed by Slack channel id';
  }
  for (const [channelId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!channelId) {
      return 'channel_map keys (Slack channel ids) must be non-empty strings';
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `channel_map[${channelId}] must be an object of shape { label?, agentId? }`;
    }
    const { label, agentId } = entry as { label?: unknown; agentId?: unknown };
    if (label !== undefined && typeof label !== 'string') {
      return `channel_map[${channelId}].label must be a string when provided`;
    }
    if (agentId !== undefined && typeof agentId !== 'string') {
      return `channel_map[${channelId}].agentId must be a string when provided`;
    }
  }
  return null;
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
  router.post('/api/slack/bots', requireRole('Admin'), async (req: Request, res: Response) => {
    const { name, bot_token, app_token, agent_id, channel_map = {}, enabled = true } = req.body;
    if (!name || !bot_token || !app_token || !agent_id) {
      return res
        .status(400)
        .json({ error: 'name, bot_token, app_token, and agent_id are required' });
    }
    const cmErr = validateChannelMap(channel_map);
    if (cmErr) return res.status(400).json({ error: cmErr });
    const id = randomUUID();
    try {
      stmts.insertSlackBot.run(
        id,
        name.trim(),
        encryptSecret(bot_token.trim()),
        encryptSecret(app_token.trim()),
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
  router.put('/api/slack/bots/:id', requireRole('Admin'), async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Bot not found' });

    const { name = existing.name, agent_id = existing.agent_id, channel_map, enabled } = req.body;
    const cmErr = validateChannelMap(channel_map);
    if (cmErr) return res.status(400).json({ error: cmErr });

    // Only replace tokens if explicitly provided (non-empty, non-masked).
    // existing.bot_token / app_token are already encrypted in the DB — keep as-is or re-encrypt new values.
    let bot_token = existing.bot_token;
    let app_token = existing.app_token;
    if (req.body.bot_token && !req.body.bot_token.includes('****')) {
      bot_token = encryptSecret(req.body.bot_token.trim());
    }
    if (req.body.app_token && !req.body.app_token.includes('****')) {
      app_token = encryptSecret(req.body.app_token.trim());
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
  router.post(
    '/api/slack/bots/:id/toggle',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
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
    },
  );

  // ── Delete bot ─────────────────────────────────────────────────────────────
  router.delete(
    '/api/slack/bots/:id',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
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
    },
  );

  // ── Test connection ────────────────────────────────────────────────────────
  // Validates the bot token by calling Slack auth.test — does NOT require the
  // full Bolt app startup. Can be called with either the bot's id (uses stored
  // token) or with raw tokens in the body (for new-bot wizard before saving).
  router.post(
    '/api/slack/bots/:id/test',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const { id } = req.params;
      const existing = stmts.getSlackBot.get(id) as SlackBotRow | undefined;
      if (!existing) return res.status(404).json({ error: 'Bot not found' });

      // Use stored token (decrypt from DB) unless a fresh token was passed in body.
      const botToken =
        req.body.bot_token && !req.body.bot_token.includes('****')
          ? req.body.bot_token.trim()
          : decryptSecret(existing.bot_token);

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
    },
  );

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

  // ── Existing endpoints (kept here for co-location) ──────────────────────────

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

/**
 * Claude Code authentication management routes.
 *
 * Exposes endpoints to:
 *   - Check auth status (OAuth + API key)
 *   - Trigger OAuth login flow and return the auth URL for the UI
 *   - Manage Anthropic API key (alternative to OAuth)
 *   - Logout from Claude Code OAuth
 *
 * Claude Code supports two auth methods:
 *   1. OAuth (default) — `claude auth login` stores tokens in ~/.claude/.credentials.json
 *   2. API key — ANTHROPIC_API_KEY env var passed to spawned processes
 *
 * OAuth flow through the UI:
 *   1. Client POSTs to /api/config/claude-auth/login
 *   2. Server spawns `claude auth login` with BROWSER=false to suppress auto-open
 *   3. CLI prints the OAuth URL ("If the browser didn't open, visit: <URL>")
 *   4. Server captures the URL and returns it to the client
 *   5. Client opens the URL in a new tab — user authenticates on claude.com
 *   6. OAuth callback completes, CLI writes tokens to ~/.claude/.credentials.json
 *   7. Client polls GET /api/config/claude-auth to confirm success
 */

import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const HOME = os.homedir();
const CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');

/**
 * Run a claude CLI command and collect its stdout/stderr.
 * Returns { stdout, stderr, code }.
 */
function runClaude(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: HOME,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 15_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

/**
 * Extract an OAuth URL from CLI output text.
 * The CLI prints: "If the browser didn't open, visit: <URL>"
 */
function extractOAuthUrl(text) {
  const match = text.match(/visit:\s*(https:\/\/\S+)/i);
  return match ? match[1] : null;
}

export default function createClaudeAuthRoutes(deps) {
  const { config, broadcast } = deps;
  const router = Router();

  // Track in-flight OAuth login process
  let activeLoginProc = null;
  let activeLoginId = null;

  // ─── GET /api/config/claude-auth ──────────────────────────────
  // Returns current Claude Code auth status + API key configuration.
  router.get('/api/config/claude-auth', async (_req, res) => {
    try {
      // 1. Check OAuth status via CLI
      const { stdout, code } = await runClaude(config.claudeBin, ['auth', 'status']);
      let oauthStatus = null;

      if (code === 0 && stdout.trim()) {
        try {
          oauthStatus = JSON.parse(stdout.trim());
        } catch {
          oauthStatus = { raw: stdout.trim() };
        }
      }

      // 2. Check credentials file for token expiry info
      let tokenInfo = null;
      if (existsSync(CREDENTIALS_PATH)) {
        try {
          const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
          const oauth = creds.claudeAiOauth;
          if (oauth) {
            tokenInfo = {
              expiresAt: oauth.expiresAt,
              expired: oauth.expiresAt ? Date.now() > oauth.expiresAt : null,
              scopes: oauth.scopes || [],
              subscriptionType: oauth.subscriptionType || null,
              rateLimitTier: oauth.rateLimitTier || null,
            };
          }
        } catch {
          /* credentials file unreadable */
        }
      }

      // 3. Check if API key is configured
      const apiKeyConfigured = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);

      // 4. Check if a login is in progress
      const loginInProgress = !!activeLoginProc;

      res.json({
        oauth: oauthStatus,
        token: tokenInfo,
        apiKey: {
          configured: apiKeyConfigured,
          source: process.env.ANTHROPIC_API_KEY
            ? 'environment'
            : config.anthropicApiKey
              ? 'config'
              : null,
        },
        activeMethod: apiKeyConfigured ? 'api-key' : oauthStatus?.loggedIn ? 'oauth' : 'none',
        loginInProgress,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to check auth status: ${err.message}` });
    }
  });

  // ─── POST /api/config/claude-auth/login ───────────────────────
  // Initiates Claude Code OAuth login flow.
  //
  // Spawns `claude auth login` with BROWSER=false so it doesn't try
  // to open a browser. Captures the OAuth URL from the CLI output
  // and returns it to the client. The client opens the URL in a new
  // tab for the user to authenticate.
  //
  // The spawned process stays alive waiting for the OAuth callback.
  // Once the user completes auth, the process exits and tokens are
  // written to ~/.claude/.credentials.json.
  //
  // Options:
  //   method: 'console' — use Anthropic Console (API billing) login
  //   email: string     — pre-populate email on login page
  //   sso: boolean      — force SSO login flow
  router.post('/api/config/claude-auth/login', (req, res) => {
    // Kill any existing login process
    if (activeLoginProc) {
      try {
        activeLoginProc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      activeLoginProc = null;
      activeLoginId = null;
    }

    const { method, email, sso } = req.body || {};
    const args = ['auth', 'login'];

    if (method === 'console') {
      args.push('--console');
    }
    if (email) {
      args.push('--email', email);
    }
    if (sso) {
      args.push('--sso');
    }

    const loginId = Date.now().toString(36);
    activeLoginId = loginId;

    // Suppress browser auto-open so we can capture the URL
    const proc = spawn(config.claudeBin, args, {
      cwd: HOME,
      env: { ...process.env, BROWSER: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeLoginProc = proc;

    let allOutput = '';
    let urlSent = false;
    let responded = false;

    const sendUrl = (url) => {
      if (responded) return;
      responded = true;
      urlSent = true;
      res.json({ ok: true, loginId, oauthUrl: url });
    };

    const onData = (chunk) => {
      allOutput += chunk.toString();

      // Look for the OAuth URL in the output
      if (!urlSent) {
        const url = extractOAuthUrl(allOutput);
        if (url) sendUrl(url);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    // If the process exits before we find a URL, report whatever we got
    proc.on('close', (code) => {
      if (activeLoginId === loginId) {
        activeLoginProc = null;
        activeLoginId = null;
      }

      if (!responded) {
        responded = true;
        if (code === 0) {
          res.json({
            ok: true,
            loginId,
            completed: true,
            output: 'Login completed successfully',
          });
        } else {
          res.json({
            ok: false,
            loginId,
            output: allOutput.trim() || 'Login process exited unexpectedly',
          });
        }
      } else {
        // URL was already sent — notify via broadcast that login completed
        const status = code === 0 ? 'success' : 'failed';
        console.log(`[claude-auth] OAuth login ${status} (loginId=${loginId})`);
        if (broadcast) {
          broadcast({
            type: 'claude-auth-update',
            loginId,
            status,
          });
        }
      }
    });

    proc.on('error', (err) => {
      if (activeLoginId === loginId) {
        activeLoginProc = null;
        activeLoginId = null;
      }
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // Safety timeout: if no URL appears within 15 seconds, respond with error
    setTimeout(() => {
      if (!responded) {
        responded = true;
        res.json({
          ok: false,
          output: allOutput.trim() || 'Timed out waiting for OAuth URL',
        });
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 15_000);
  });

  // ─── POST /api/config/claude-auth/cancel-login ────────────────
  // Cancel an in-progress OAuth login.
  router.post('/api/config/claude-auth/cancel-login', (_req, res) => {
    if (activeLoginProc) {
      try {
        activeLoginProc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      activeLoginProc = null;
      activeLoginId = null;
      res.json({ ok: true, output: 'Login cancelled' });
    } else {
      res.json({ ok: true, output: 'No login in progress' });
    }
  });

  // ─── POST /api/config/claude-auth/api-key ─────────────────────
  // Set or update the Anthropic API key used for Claude Code sessions.
  // Stored in config.json and passed as ANTHROPIC_API_KEY env var
  // to all spawned CLI processes.
  router.post('/api/config/claude-auth/api-key', (req, res) => {
    const { apiKey } = req.body || {};
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }

    // Update config.json
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      /* no file yet */
    }

    if (apiKey) {
      fileConfig.anthropicApiKey = apiKey;
      config.anthropicApiKey = apiKey;
    } else {
      // Clear API key
      delete fileConfig.anthropicApiKey;
      config.anthropicApiKey = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!apiKey,
      masked: apiKey ? `••••••••${apiKey.slice(-4)}` : null,
    });
  });

  // ─── POST /api/config/claude-auth/validate-key ────────────────
  // Validate an API key by running a minimal Claude Code command.
  router.post('/api/config/claude-auth/validate-key', async (req, res) => {
    const { apiKey } = req.body || {};
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    try {
      const { stdout, stderr, code } = await runClaude(
        config.claudeBin,
        ['--print', '--bare', '--model', 'claude-haiku-4-6', 'Reply with only the word OK'],
        {
          env: { ANTHROPIC_API_KEY: apiKey },
          timeout: 30_000,
        },
      );

      const output = stdout.trim();
      const valid = code === 0 && output.toLowerCase().includes('ok');

      res.json({
        valid,
        output: valid ? 'API key is valid' : stderr.trim() || output || 'Validation failed',
      });
    } catch (err) {
      res.json({ valid: false, output: err.message });
    }
  });

  // ─── DELETE /api/config/claude-auth ────────────────────────────
  // Logout from Claude Code OAuth.
  router.delete('/api/config/claude-auth', async (_req, res) => {
    try {
      const { stdout, stderr, code } = await runClaude(config.claudeBin, ['auth', 'logout']);
      res.json({
        ok: code === 0,
        output: stdout.trim() || stderr.trim() || 'Logged out',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NOTE: These process-level signal handlers are registered once at startup.
  // If createClaudeAuthRoutes were ever called more than once (e.g., in tests),
  // duplicate listeners would accumulate. Guard or deregister if that changes.
  const cleanup = () => {
    if (activeLoginProc) {
      try {
        activeLoginProc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      activeLoginProc = null;
      activeLoginId = null;
    }
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return router;
}

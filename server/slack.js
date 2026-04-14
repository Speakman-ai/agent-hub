import { App } from '@slack/bolt';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMemoryContext, appendDailyNote } from './memory.js';

import config, { buildSpawnEnv } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_BIN = config.claudeBin;
const CURSOR_BIN = config.cursorBin;
const TIMEOUT_MS = config.slackTimeoutMs;

// Active bot instances: Map<accountName, { app, botUserId, connected, lastMessage, error }>
const bots = new Map();

// Per-agent processing queue: Map<agentId, { processing: boolean, queue: [] }>
const agentQueues = new Map();

// References to db statements (injected at start)
let dbStmts = null;
let _agentConfigs = [];

function loadSlackConfig() {
  try {
    const raw = readFileSync(path.join(__dirname, 'slack-config.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load slack-config.json:', err.message);
    return { accounts: [] };
  }
}

function getAgentQueue(agentId) {
  if (!agentQueues.has(agentId)) {
    agentQueues.set(agentId, { processing: false, queue: [] });
  }
  return agentQueues.get(agentId);
}

async function processQueue(agentId) {
  const q = getAgentQueue(agentId);
  if (q.processing || q.queue.length === 0) return;

  q.processing = true;
  const task = q.queue.shift();

  try {
    await task();
  } catch (err) {
    console.error(`Queue task failed for agent ${agentId}:`, err.message);
  } finally {
    q.processing = false;
    if (q.queue.length > 0) {
      processQueue(agentId);
    }
  }
}

function enqueueMessage(agentId, task) {
  const q = getAgentQueue(agentId);
  q.queue.push(task);
  processQueue(agentId);
}

async function getThreadContext(client, channel, threadTs, limit = 10) {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit,
    });
    return (result.messages || []).map((m) => ({
      user: m.user || 'bot',
      text: m.text || '',
      ts: m.ts,
    }));
  } catch {
    return [];
  }
}

function runAgent(systemPrompt, userMessage, cwd, engine = 'claude-code') {
  return new Promise((resolve, reject) => {
    let args;
    let bin;

    if (engine === 'cursor-agent') {
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
      args = ['-p', combinedPrompt, '--force'];
      bin = CURSOR_BIN;
    } else {
      args = ['--print', '--permission-mode', 'bypassPermissions'];
      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }
      args.push(userMessage);
      bin = CLAUDE_BIN;
    }

    let output = '';
    let errorOutput = '';

    const proc = spawn(bin, args, {
      cwd,
      env: buildSpawnEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude timed out after 5 minutes'));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !output) {
        reject(new Error(errorOutput || `Claude exited with code ${code}`));
      } else {
        resolve(output.trim() || errorOutput.trim() || '(empty response)');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function handleMessage(account, agent, { client, message, say }) {
  const botInfo = bots.get(account.name);
  if (!botInfo) return;

  // Ignore messages from this bot itself (but allow other bots for inter-agent channels)
  if (message.user === botInfo.botUserId) return;

  // Ignore message subtypes (edits, deletes, etc.) but allow thread_broadcast and file_share
  const allowedSubtypes = ['thread_broadcast', 'file_share'];
  if (message.subtype && !allowedSubtypes.includes(message.subtype)) return;

  console.log(
    `[Slack] Message from ${message.user} in ${message.channel} (subtype: ${message.subtype || 'none'}, files: ${message.files?.length || 0})`,
  );

  const channel = message.channel;
  const threadTs = message.thread_ts || message.ts;
  const userText = message.text || '';

  // Download any attached images/files
  const attachedFiles = [];
  if (message.files && message.files.length > 0) {
    const downloadDir = agent?.workspace
      ? path.join(agent.workspace, 'slack-uploads')
      : path.join(__dirname, 'slack-uploads');
    mkdirSync(downloadDir, { recursive: true });

    for (const file of message.files) {
      if (!file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${bots.get(account.name)?.account?.botToken}` },
        });
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          const safeName = `${Date.now()}-${file.name || 'file'}`;
          const filePath = path.join(downloadDir, safeName);
          writeFileSync(filePath, buffer);
          attachedFiles.push({ name: file.name, path: filePath, mimetype: file.mimetype });
        }
      } catch (err) {
        console.error(`Failed to download file ${file.name}:`, err.message);
      }
    }
  }

  if (!userText.trim() && attachedFiles.length === 0) return;

  // Add 👀 reaction
  try {
    await client.reactions.add({
      channel,
      timestamp: message.ts,
      name: 'eyes',
    });
  } catch {
    /* ignore reaction errors */
  }

  try {
    // Build context for threaded conversations
    let prompt = '';
    if (message.thread_ts) {
      const threadMsgs = await getThreadContext(client, channel, message.thread_ts);
      // Exclude the current message from context
      const context = threadMsgs
        .filter((m) => m.ts !== message.ts)
        .map((m) => `${m.user === botInfo.botUserId ? 'Assistant' : 'User'}: ${m.text}`)
        .join('\n');
      if (context) {
        prompt = `Previous thread conversation:\n${context}\n\nUser: ${userText}`;
      } else {
        prompt = userText;
      }
    } else {
      prompt = userText || '';
    }

    // Append attached file references to the prompt
    if (attachedFiles.length > 0) {
      const fileDescs = attachedFiles.map((f) => {
        const isImage = f.mimetype && f.mimetype.startsWith('image/');
        return isImage
          ? `[Attached image: ${f.name} — saved to ${f.path}. Please analyze this image using your vision/file reading capabilities.]`
          : `[Attached file: ${f.name} (${f.mimetype}) — saved to ${f.path}]`;
      });
      prompt = (prompt ? prompt + '\n\n' : '') + fileDescs.join('\n');
    }

    // Build enriched system prompt with memory
    let systemPrompt = agent?.systemPrompt || '';
    if (agent?.workspace) {
      const memoryContext = getMemoryContext(agent.workspace);
      if (memoryContext) {
        systemPrompt += '\n\n' + memoryContext;
      }
      systemPrompt +=
        '\n\n## Memory Instructions\nYou have access to memory files in your workspace. The memory context above shows your current knowledge.\nWhen you learn something important (decisions, preferences, key facts), mention it in your response so it gets logged.';
    }

    // Run agent (respects engine setting)
    const response = await runAgent(
      systemPrompt,
      prompt,
      agent?.cwd || config.defaultCwd,
      agent?.engine || 'claude-code',
    );

    // Only thread if the user started a thread — otherwise reply in channel
    const shouldThread = !!message.thread_ts;
    await say({
      text: response,
      thread_ts: shouldThread ? threadTs : undefined,
    });

    // Log to DB
    if (dbStmts) {
      try {
        dbStmts.addSlackMessage.run(
          account.agentId,
          channel,
          threadTs,
          message.user,
          userText,
          response,
        );
      } catch (err) {
        console.error('Failed to log Slack message:', err.message);
      }
    }

    // Update bot's last message time
    botInfo.lastMessage = new Date().toISOString();

    // Append to daily notes
    if (agent?.workspace) {
      const summary = `**Slack #${channel}** — User: ${userText.substring(0, 100)}${userText.length > 100 ? '...' : ''}\nBot: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`;
      appendDailyNote(agent.workspace, summary);
    }

    // Remove 👀, add ✅
    try {
      await client.reactions.remove({ channel, timestamp: message.ts, name: 'eyes' });
    } catch {
      /* ignore */
    }
    try {
      await client.reactions.add({ channel, timestamp: message.ts, name: 'white_check_mark' });
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.error(`Slack message handler error (${account.name}):`, err.message);

    // Post error
    try {
      await say({
        text: `⚠️ Error: ${err.message}`,
        thread_ts: threadTs,
      });
    } catch {
      /* ignore */
    }

    // Remove 👀, add ❌
    try {
      await client.reactions.remove({ channel, timestamp: message.ts, name: 'eyes' });
    } catch {
      /* ignore */
    }
    try {
      await client.reactions.add({ channel, timestamp: message.ts, name: 'x' });
    } catch {
      /* ignore */
    }
  }
}

async function startBot(account, agents) {
  if (account.botToken === 'PLACEHOLDER' || account.appToken === 'PLACEHOLDER') {
    console.log(`Skipping Slack bot "${account.name}" — tokens are PLACEHOLDER`);
    bots.set(account.name, {
      app: null,
      botUserId: null,
      connected: false,
      lastMessage: null,
      error: 'Tokens not configured',
      account,
    });
    return;
  }

  try {
    const boltApp = new App({
      token: account.botToken,
      appToken: account.appToken,
      socketMode: true,
      // Disable built-in receiver logging for cleaner output
    });

    // Find matching agent config
    const agent = agents.find((a) => a.id === account.agentId);

    // Listen for all messages
    boltApp.message(async (args) => {
      enqueueMessage(account.agentId, () => handleMessage(account, agent, args));
    });

    // Handle errors
    boltApp.error(async (error) => {
      console.error(`Slack bot "${account.name}" error:`, error);
      const botInfo = bots.get(account.name);
      if (botInfo) {
        botInfo.error = error.message || 'Unknown error';
      }
    });

    await boltApp.start();

    // Get bot user ID to filter self-messages
    let botUserId = null;
    try {
      const authResult = await boltApp.client.auth.test({ token: account.botToken });
      botUserId = authResult.user_id;
    } catch (err) {
      console.warn(`Could not get bot user ID for "${account.name}":`, err.message);
    }

    console.log(`✅ Slack bot "${account.name}" connected (agent: ${account.agentId})`);
    bots.set(account.name, {
      app: boltApp,
      botUserId,
      connected: true,
      lastMessage: null,
      error: null,
      account,
    });
  } catch (err) {
    console.error(`❌ Failed to start Slack bot "${account.name}":`, err.message);
    bots.set(account.name, {
      app: null,
      botUserId: null,
      connected: false,
      lastMessage: null,
      error: err.message,
      account,
    });
  }
}

async function stopBot(name) {
  const botInfo = bots.get(name);
  if (botInfo?.app) {
    try {
      await botInfo.app.stop();
    } catch (err) {
      console.warn(`Error stopping bot "${name}":`, err.message);
    }
  }
  bots.delete(name);
}

async function stopAllBots() {
  const names = [...bots.keys()];
  for (const name of names) {
    await stopBot(name);
  }
  agentQueues.clear();
}

export async function startSlack(agents, stmts) {
  dbStmts = stmts;
  _agentConfigs = agents;

  const config = loadSlackConfig();
  if (!config.accounts || config.accounts.length === 0) {
    console.log('No Slack accounts configured');
    return;
  }

  console.log(`Starting ${config.accounts.length} Slack bot(s)...`);

  // Start all bots concurrently — failures are isolated
  await Promise.allSettled(config.accounts.map((account) => startBot(account, agents)));

  const connected = [...bots.values()].filter((b) => b.connected).length;
  const total = config.accounts.length;
  console.log(`Slack: ${connected}/${total} bots connected`);
}

export async function restartSlack(agents, stmts) {
  console.log('Restarting all Slack bots...');
  await stopAllBots();
  await startSlack(agents, stmts);
}

export function getSlackStatus() {
  const status = [];
  for (const [name, info] of bots) {
    status.push({
      name,
      agentId: info.account?.agentId || 'unknown',
      connected: info.connected,
      lastMessage: info.lastMessage,
      error: info.error,
    });
  }
  return status;
}

export function getSlackMessages(agentId, limit = 50) {
  if (!dbStmts) return [];
  try {
    return dbStmts.getSlackMessages.all(agentId, limit);
  } catch {
    return [];
  }
}

export function getAllSlackMessages(limit = 100) {
  if (!dbStmts) return [];
  try {
    return dbStmts.getAllSlackMessages.all(limit);
  } catch {
    return [];
  }
}

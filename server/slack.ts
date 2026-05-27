import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { CodedError, SayFn, SlackEventMiddlewareArgs } from '@slack/bolt';
import { spawn } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMemoryContext, appendDailyNote } from './memory.js';
import config, { buildSpawnEnv } from './config.js';
import { getProjects } from './project-model.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { getOrgOwnerUserId } from './session-ownership.js';
import { claudePermissionModeForSpawn, disableNativeSkillToolArgs } from './claude-cli-args.js';
import type { EnrichedAgent, Stmts, SlackMessageRow, SlackBotRow } from './types.js';
import { decryptSecret } from './secret-crypto.js';

/**
 * Decrypt a stored secret, falling back to the raw stored value when the
 * blob isn't in `iv:tag:ciphertext` shape. `slack_bots` is a brand-new
 * table in the PR introducing this module, so today every row is encrypted.
 * A hand-inserted row (manual SQL fix-up, restored backup) wouldn't be —
 * we'd rather forward the plaintext to Bolt and let `auth.test` fail with
 * a real Slack error than 500 the entire `startSlack` boot path on
 * `Malformed ciphertext blob`. Anything else (e.g. wrong AES key)
 * re-throws so we don't silently mask a real misconfiguration.
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

const __dirname: string = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_BIN: string = config.claudeBin;
const CURSOR_BIN: string = config.cursorBin;
const GEMINI_BIN: string = config.geminiBin;
const CODEX_BIN: string = config.codexBin;
const TIMEOUT_MS: number = config.slackTimeoutMs;

export interface SlackAccount {
  name: string;
  botToken: string;
  appToken: string;
  agentId: string;
  /** Per-channel agent overrides: channelId → agentId */
  channelMap?: Record<string, string>;
}

/**
 * Resolve the target agentId for an inbound message.
 * Checks channelMap first; falls back to account.agentId.
 */
export function resolveAgentForChannel(
  account: SlackAccount,
  channelId: string | undefined,
): string {
  if (channelId) {
    const override = account.channelMap?.[channelId];
    if (override) return override;
  }
  return account.agentId;
}

interface SlackConfig {
  accounts: SlackAccount[];
}

interface BotInfo {
  app: App | null;
  botUserId: string | null;
  connected: boolean;
  lastMessage: string | null;
  error: string | null;
  account: SlackAccount;
}

interface AgentQueue {
  processing: boolean;
  queue: Array<() => Promise<void>>;
}

interface SlackFile {
  name?: string;
  url_private?: string;
  mimetype?: string;
}

interface SlackMessage {
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  channel: string;
  files?: SlackFile[];
}

interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
}

interface AttachedFile {
  name: string | undefined;
  path: string;
  mimetype: string | undefined;
}

interface HandleMessageArgs {
  client: WebClient;
  message: SlackMessage;
  say: SayFn;
}

interface SlackStatusEntry {
  name: string;
  agentId: string;
  connected: boolean;
  lastMessage: string | null;
  error: string | null;
}

const bots = new Map<string, BotInfo>();
const agentQueues = new Map<string, AgentQueue>();

let dbStmts: Stmts | null = null;
let _agentConfigs: EnrichedAgent[] = [];

export function loadSlackConfig(
  configPath: string = path.join(__dirname, 'slack-config.json'),
): SlackConfig {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as SlackConfig;
  } catch (err) {
    // Missing config is the common case for fresh installs / dev environments
    // (slack-config.json is gitignored). Stay silent so we don't spam logs.
    // Only surface non-ENOENT failures (parse errors, EACCES, etc.).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to load slack-config.json:', (err as Error).message);
    }
    return { accounts: [] };
  }
}

function getAgentQueue(agentId: string): AgentQueue {
  if (!agentQueues.has(agentId)) {
    agentQueues.set(agentId, { processing: false, queue: [] });
  }
  return agentQueues.get(agentId)!;
}

async function processQueue(agentId: string): Promise<void> {
  const q = getAgentQueue(agentId);
  if (q.processing || q.queue.length === 0) return;

  q.processing = true;
  const task = q.queue.shift()!;

  try {
    await task();
  } catch (err) {
    console.error(`Queue task failed for agent ${agentId}:`, (err as Error).message);
  } finally {
    q.processing = false;
    if (q.queue.length > 0) {
      processQueue(agentId);
    }
  }
}

function enqueueMessage(agentId: string, task: () => Promise<void>): void {
  const q = getAgentQueue(agentId);
  q.queue.push(task);
  processQueue(agentId);
}

async function getThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
  limit = 10,
): Promise<ThreadMessage[]> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit,
    });
    return ((result.messages as Array<{ user?: string; text?: string; ts?: string }>) || []).map(
      (m) => ({
        user: m.user || 'bot',
        text: m.text || '',
        ts: m.ts || '',
      }),
    );
  } catch {
    return [];
  }
}

function runAgent(
  systemPrompt: string,
  userMessage: string,
  cwd: string,
  engine = 'claude-code',
  slackAgent?: EnrichedAgent | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let args: string[];
    let bin: string;

    if (engine === 'cursor-agent') {
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
      args = ['-p', combinedPrompt, '--force'];
      bin = CURSOR_BIN;
    } else if (engine === 'gemini-cli') {
      // Gemini CLI has no --system-prompt flag; prepend it to the user turn.
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
      args = ['-p', combinedPrompt, '--yolo'];
      bin = GEMINI_BIN;
    } else if (engine === 'codex-cli') {
      // Codex exec has no --system-prompt flag either — concatenate. We stay
      // read-only here since Slack one-shots shouldn't mutate the workspace.
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userMessage}` : userMessage;
      args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (config.codexProfile) {
        args.push('--profile', config.codexProfile);
      }
      args.push(combinedPrompt);
      bin = CODEX_BIN;
    } else {
      args = ['--print', '--permission-mode', claudePermissionModeForSpawn('bypassPermissions')];
      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }
      // see claude-cli-args.ts
      args.push(...disableNativeSkillToolArgs());
      // `--` terminates option parsing so the variadic `--disallowed-tools <tools...>`
      // doesn't swallow the trailing positional prompt (Claude CLI 2.x).
      args.push('--', userMessage);
      bin = CLAUDE_BIN;
    }

    let output = '';
    let errorOutput = '';

    const slackOwnerId = getOrgOwnerUserId();
    const spawnEnv = { ...buildSpawnEnv(config, { userId: slackOwnerId }) };
    if (slackAgent && slackOwnerId) {
      const proj = getProjects().find((p) => p.id === slackAgent.projectId);
      if (proj) {
        mergeSkillCredentialSpawnEnv(spawnEnv, {
          ownerId: slackOwnerId,
          agentId: slackAgent.id,
          project: proj,
        });
      }
    }

    const proc = spawn(bin, args, {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const timeout = setTimeout(() => {
      killProcessGroup(proc, 'SIGTERM');
      reject(new Error('Claude timed out after 5 minutes'));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0 && !output) {
        reject(new Error(errorOutput || `Claude exited with code ${code}`));
      } else {
        resolve(output.trim() || errorOutput.trim() || '(empty response)');
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function handleMessage(
  account: SlackAccount,
  agent: EnrichedAgent | undefined,
  { client, message, say }: HandleMessageArgs,
): Promise<void> {
  const botInfo = bots.get(account.name);
  if (!botInfo) return;

  if (message.user === botInfo.botUserId) return;

  const allowedSubtypes = ['thread_broadcast', 'file_share'];
  if (message.subtype && !allowedSubtypes.includes(message.subtype)) return;

  console.log(
    `[Slack] Message from ${message.user} in ${message.channel} (subtype: ${message.subtype || 'none'}, files: ${message.files?.length || 0})`,
  );

  const channel = message.channel;
  const threadTs = message.thread_ts || message.ts;
  const userText = message.text || '';

  const attachedFiles: AttachedFile[] = [];
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
        console.error(`Failed to download file ${file.name}:`, (err as Error).message);
      }
    }
  }

  if (!userText.trim() && attachedFiles.length === 0) return;

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
    let prompt = '';
    if (message.thread_ts) {
      const threadMsgs = await getThreadContext(client, channel, message.thread_ts);
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

    if (attachedFiles.length > 0) {
      const fileDescs = attachedFiles.map((f) => {
        const isImage = f.mimetype && f.mimetype.startsWith('image/');
        return isImage
          ? `[Attached image: ${f.name} — saved to ${f.path}. Please analyze this image using your vision/file reading capabilities.]`
          : `[Attached file: ${f.name} (${f.mimetype}) — saved to ${f.path}]`;
      });
      prompt = (prompt ? prompt + '\n\n' : '') + fileDescs.join('\n');
    }

    let systemPrompt = agent?.systemPrompt || '';
    if (agent?.workspace) {
      const memoryContext = getMemoryContext(agent.workspace);
      if (memoryContext) {
        systemPrompt += '\n\n' + memoryContext;
      }
      systemPrompt +=
        '\n\n## Memory Instructions\nYou have access to memory files in your workspace. The memory context above shows your current knowledge.\nWhen you learn something important (decisions, preferences, key facts), mention it in your response so it gets logged.';
    }

    const response = await runAgent(
      systemPrompt,
      prompt,
      agent?.cwd || config.defaultCwd,
      agent?.engine || 'claude-code',
      agent,
    );

    const shouldThread = !!message.thread_ts;
    await say({
      text: response,
      thread_ts: shouldThread ? threadTs : undefined,
    });

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
        console.error('Failed to log Slack message:', (err as Error).message);
      }
    }

    botInfo.lastMessage = new Date().toISOString();

    if (agent?.workspace) {
      const summary = `**Slack #${channel}** — User: ${userText.substring(0, 100)}${userText.length > 100 ? '...' : ''}\nBot: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`;
      appendDailyNote(agent.workspace, summary);
    }

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
    console.error(`Slack message handler error (${account.name}):`, (err as Error).message);

    try {
      await say({
        text: `⚠️ Error: ${(err as Error).message}`,
        thread_ts: threadTs,
      });
    } catch {
      /* ignore */
    }

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

async function startBot(account: SlackAccount, agents: EnrichedAgent[]): Promise<void> {
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
    });

    boltApp.message(async (args: SlackEventMiddlewareArgs<'message'>) => {
      // Resolve agent per-message so channel_map overrides take effect.
      const channelId = (args.message as { channel?: string }).channel;
      const resolvedAgentId = resolveAgentForChannel(account, channelId);
      const resolvedAgent = agents.find((a) => a.id === resolvedAgentId);
      enqueueMessage(resolvedAgentId, () =>
        handleMessage(account, resolvedAgent, args as unknown as HandleMessageArgs),
      );
    });

    boltApp.error(async (error: CodedError) => {
      console.error(`Slack bot "${account.name}" error:`, error);
      const botEntry = bots.get(account.name);
      if (botEntry) {
        botEntry.error = (error as Error).message || 'Unknown error';
      }
    });

    await boltApp.start();

    let botUserId: string | null = null;
    try {
      const authResult = await boltApp.client.auth.test({ token: account.botToken });
      botUserId = (authResult.user_id as string) ?? null;
    } catch (err) {
      console.warn(`Could not get bot user ID for "${account.name}":`, (err as Error).message);
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
    console.error(`❌ Failed to start Slack bot "${account.name}":`, (err as Error).message);
    bots.set(account.name, {
      app: null,
      botUserId: null,
      connected: false,
      lastMessage: null,
      error: (err as Error).message,
      account,
    });
  }
}

async function stopBot(name: string): Promise<void> {
  const botInfo = bots.get(name);
  if (botInfo?.app) {
    try {
      await botInfo.app.stop();
    } catch (err) {
      console.warn(`Error stopping bot "${name}":`, (err as Error).message);
    }
  }
  bots.delete(name);
}

async function stopAllBots(): Promise<void> {
  const names = [...bots.keys()];
  for (const name of names) {
    await stopBot(name);
  }
  agentQueues.clear();
}

/** Convert a DB slack_bots row into the SlackAccount shape used internally. */
export function dbBotToAccount(row: SlackBotRow): SlackAccount {
  let channelMap: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(row.channel_map) as Record<
      string,
      { label?: string; agentId?: string }
    >;
    const mapped: Record<string, string> = {};
    for (const [channelId, entry] of Object.entries(parsed)) {
      if (entry.agentId) mapped[channelId] = entry.agentId;
    }
    if (Object.keys(mapped).length > 0) channelMap = mapped;
  } catch {
    /* ignore bad JSON */
  }
  return {
    name: row.name,
    botToken: safeDecryptSecret(row.bot_token),
    appToken: safeDecryptSecret(row.app_token),
    agentId: row.agent_id,
    channelMap,
  };
}

export async function startSlack(agents: EnrichedAgent[], stmts: Stmts): Promise<void> {
  dbStmts = stmts;
  _agentConfigs = agents;

  // Merge file-backed config (legacy) + DB-backed bots.
  const fileConfig = loadSlackConfig();
  const fileAccounts: SlackAccount[] = fileConfig.accounts || [];

  let dbAccounts: SlackAccount[] = [];
  try {
    const rows = stmts.listSlackBots.all() as SlackBotRow[];
    dbAccounts = rows.filter((r) => r.enabled).map(dbBotToAccount);
  } catch (err) {
    // DB may not have the table yet during initial startup
    console.warn('[Slack] Could not load DB bots:', (err as Error).message);
  }

  // Deduplicate by name — DB rows take precedence over file entries with the same name.
  const dbNames = new Set(dbAccounts.map((a) => a.name));
  const mergedAccounts = [...dbAccounts, ...fileAccounts.filter((a) => !dbNames.has(a.name))];

  if (mergedAccounts.length === 0) {
    console.log('No Slack accounts configured');
    return;
  }

  console.log(
    `Starting ${mergedAccounts.length} Slack bot(s) (${dbAccounts.length} DB, ${mergedAccounts.length - dbAccounts.length} file)...`,
  );

  await Promise.allSettled(mergedAccounts.map((account) => startBot(account, agents)));

  const connected = [...bots.values()].filter((b) => b.connected).length;
  const total = mergedAccounts.length;
  console.log(`Slack: ${connected}/${total} bots connected`);
}

export async function restartSlack(agents: EnrichedAgent[], stmts: Stmts): Promise<void> {
  console.log('Restarting all Slack bots...');
  await stopAllBots();
  await startSlack(agents, stmts);
}

export function getSlackStatus(): SlackStatusEntry[] {
  const status: SlackStatusEntry[] = [];
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

export function getSlackMessages(agentId: string, limit = 50): SlackMessageRow[] {
  if (!dbStmts) return [];
  try {
    return dbStmts.getSlackMessages.all(agentId, limit) as SlackMessageRow[];
  } catch {
    return [];
  }
}

export function getAllSlackMessages(limit = 100): SlackMessageRow[] {
  if (!dbStmts) return [];
  try {
    return dbStmts.getAllSlackMessages.all(limit) as SlackMessageRow[];
  } catch {
    return [];
  }
}

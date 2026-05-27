/**
 * Multi-agent session orchestration — advisor ping-pong with primary executor.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { v4 as uuidv4 } from 'uuid';
import { buildSpawnEnv } from './config.js';
import { resolveEffectiveModel } from './effective-model.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { mergeProjectSecretsSpawnEnv } from './project-secrets-spawn.js';
import { mergeProjectAwsSpawnEnv } from './project-aws-spawn.js';
import { getWsAuthUserId, getOrgOwnerUserId, type AuthStampedWs } from './session-ownership.js';
import { createStreamParser } from './stream-parser.js';
import { buildSessionMultiSpawnArgs, normalizeSessionMultiEngine } from './session-multi-engine.js';
import type {
  Stmts,
  EnrichedAgent,
  SessionRow,
  SessionAgentRow,
  MessageRow,
  MessageQueueRow,
  AppConfig,
  BroadcastFn,
  StreamEvent,
  ChatMessage,
} from './types.js';
import { findAgent } from './project-model.js';

interface MultiAgentDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  buildEnrichedPrompt: (agent: EnrichedAgent) => string;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  getConfig: () => AppConfig;
  getMaxQueueSize: () => number;
  runExecutorTurn: (ws: WebSocketLike | null, msg: InternalMultiAgentMsg) => Promise<void>;
}

interface RoundState {
  proc: ChildProcess | null;
  cancelled: boolean;
}

interface WebSocketLike {
  send: (data: string) => void;
}

export interface InternalMultiAgentMsg extends ChatMessage {
  _fromQueue?: boolean;
  _multiAgentInternal?: boolean;
  _skipUserMessagePersist?: boolean;
  _advisorFeedback?: { name: string; content: string };
}

let deps: MultiAgentDeps | null = null;

export function initSessionMultiAgent(d: MultiAgentDeps): void {
  deps = d;
}

function getDeps(): MultiAgentDeps {
  if (!deps) throw new Error('session-multi-agent: initSessionMultiAgent() must be called first');
  return deps;
}

export const activeMultiAgentRounds = new Map<string, RoundState>();
const drainingLock = new Set<string>();

export function parseMentions(text: string, agentList: EnrichedAgent[]): Set<string> {
  const mentioned = new Set<string>();
  const sorted = [...agentList].sort((a, b) => b.name.length - a.name.length);
  for (const agent of sorted) {
    const pattern = new RegExp(`@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) {
      mentioned.add(agent.id);
    }
  }
  return mentioned;
}

export function sessionHasAdvisors(stmts: Stmts, sessionId: string): boolean {
  const rows = stmts.getSessionAgents.all(sessionId) as SessionAgentRow[];
  return rows.length > 0;
}

type TurnKind = 'executor_initial' | 'advisor' | 'executor_followup';

interface PlannedTurn {
  kind: TurnKind;
  agent: EnrichedAgent;
  advisorFeedback?: { name: string; content: string };
}

export function buildMultiAgentTurnPlan(
  primary: EnrichedAgent,
  advisors: EnrichedAgent[],
  userContent: string,
  maxAdvisorTurns: number,
): PlannedTurn[] {
  const userMentions = parseMentions(userContent, advisors);
  const advisorQueue =
    userMentions.size > 0 ? advisors.filter((a) => userMentions.has(a.id)) : [...advisors];

  const capped = maxAdvisorTurns === 0 ? advisorQueue : advisorQueue.slice(0, maxAdvisorTurns);

  const plan: PlannedTurn[] = [{ kind: 'executor_initial', agent: primary }];
  for (const advisor of capped) {
    plan.push({ kind: 'advisor', agent: advisor });
    plan.push({ kind: 'executor_followup', agent: primary, advisorFeedback: undefined });
  }
  return plan;
}

function createAdvisorCursorChat(
  cursorBin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cursorBin, ['create-chat'], { cwd, env }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`cursor create-chat failed: ${stderr || err.message}`));
        return;
      }
      const id = (stdout || '').trim().split(/\s+/).pop();
      if (!id) {
        reject(new Error('cursor create-chat returned no id'));
        return;
      }
      resolve(id);
    });
  });
}

export function handleMultiAgentCancel(sessionId: string): void {
  const state = activeMultiAgentRounds.get(sessionId);
  if (state) {
    state.cancelled = true;
    if (state.proc) killProcessGroup(state.proc, 'SIGTERM');
  }
}

function drainQueue(sessionId: string, agentId: string): void {
  const d = getDeps();
  if (drainingLock.has(sessionId)) return;
  drainingLock.add(sessionId);
  try {
    const next = d.stmts.getNextQueuedMessage.get(sessionId) as MessageQueueRow | undefined;
    if (!next) return;
    d.stmts.dequeueMessage.run(next.id);
    d.broadcast({
      type: 'queue_updated',
      sessionId,
      queue: d.stmts.getQueuedMessages.all(sessionId),
    });
    void handleMultiAgentChat(null, {
      type: 'chat',
      agentId,
      sessionId,
      content: next.content,
      _fromQueue: true,
      _existingMsgId: next.id,
    }).catch((err: unknown) => {
      console.error('[multi-agent-drain]', err instanceof Error ? err.message : err);
    });
  } finally {
    drainingLock.delete(sessionId);
  }
}

export async function handleMultiAgentChat(
  ws: WebSocketLike | null,
  msg: InternalMultiAgentMsg,
): Promise<void> {
  const { sessionId, agentId, content } = msg;
  const d = getDeps();
  const S = d.stmts;
  const config = d.getConfig();
  const MAX_QUEUE_SIZE = d.getMaxQueueSize();

  const session = S.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown session: ${sessionId}` }));
    return;
  }

  const primary = d.getEnrichedAgent(session.agent_id);
  if (!primary) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: 'Primary agent not found' }));
    return;
  }

  const advisorRows = S.getSessionAgents.all(sessionId) as SessionAgentRow[];
  const advisors = advisorRows
    .map((r) => d.getEnrichedAgent(r.agent_id))
    .filter((a): a is EnrichedAgent => !!a);

  if (advisors.length === 0) {
    return d.runExecutorTurn(ws, msg);
  }

  if (activeMultiAgentRounds.has(sessionId) && !msg._fromQueue) {
    const currentQueue = S.getQueuedMessages.all(sessionId) as MessageQueueRow[];
    if (currentQueue.length >= MAX_QUEUE_SIZE) {
      if (ws) {
        ws.send(
          JSON.stringify({
            type: 'error',
            sessionId,
            error: `Queue is full (max ${MAX_QUEUE_SIZE} messages). Wait for current round to complete.`,
          }),
        );
      }
      return;
    }
    const queueMsgId = uuidv4();
    const maxPos = S.getMaxQueuePosition.get(sessionId) as { max_pos: number | null } | undefined;
    const position = (maxPos?.max_pos ?? -1) + 1;
    S.addMessage.run(
      queueMsgId,
      sessionId,
      'user',
      content,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    S.touchSession.run(sessionId);
    S.enqueueMessage.run(queueMsgId, sessionId, agentId, content, null, position);
    d.broadcast({
      type: 'message',
      message: {
        id: queueMsgId,
        session_id: sessionId,
        role: 'user',
        content,
        queued: true,
        created_at: new Date().toISOString(),
      },
    });
    d.broadcast({
      type: 'queue_updated',
      sessionId,
      queue: S.getQueuedMessages.all(sessionId),
    });
    return;
  }

  const roundState: RoundState = { proc: null, cancelled: false };
  activeMultiAgentRounds.set(sessionId, roundState);

  if (!msg._fromQueue && !msg._skipUserMessagePersist) {
    const userMsgId = uuidv4();
    S.addMessage.run(
      userMsgId,
      sessionId,
      'user',
      content,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    S.touchSession.run(sessionId);
    d.broadcast({
      type: 'message',
      message: {
        id: userMsgId,
        session_id: sessionId,
        role: 'user',
        content,
        created_at: new Date().toISOString(),
      },
    });
  }

  const maxAdvisorTurns = session.max_turns ?? 10;
  let plan = buildMultiAgentTurnPlan(primary, advisors, content, maxAdvisorTurns);

  d.broadcast({ type: 'session_round_start', sessionId, agentCount: plan.length });

  try {
    for (let i = 0; i < plan.length; i++) {
      if (roundState.cancelled) break;
      let turn = plan[i]!;

      if (turn.kind === 'executor_followup' && !turn.advisorFeedback) {
        const prevAdvisor = plan[i - 1];
        if (prevAdvisor?.kind === 'advisor') {
          const lastAssistant = (S.getMessages.all(sessionId) as MessageRow[])
            .filter((m) => m.role === 'assistant' && m.agent_id === prevAdvisor.agent.id)
            .pop();
          turn = {
            ...turn,
            advisorFeedback: {
              name: prevAdvisor.agent.name,
              content: lastAssistant?.content ?? '',
            },
          };
          plan[i] = turn;
        }
      }

      if (turn.kind === 'executor_initial' || turn.kind === 'executor_followup') {
        const followUpContent = turn.advisorFeedback
          ? `The advisor ${turn.advisorFeedback.name} said:\n\n${turn.advisorFeedback.content}\n\nImplement or address their feedback in the codebase.`
          : content;
        await d.runExecutorTurn(ws, {
          type: 'chat',
          agentId: primary.id,
          sessionId,
          content: followUpContent,
          _multiAgentInternal: true,
          _skipUserMessagePersist: true,
          _advisorFeedback: turn.advisorFeedback,
        });
        continue;
      }

      // Advisor turn (read-only)
      await runAdvisorTurn(ws, session, primary, turn.agent, roundState);
    }
  } finally {
    const wasCancelled = roundState.cancelled;
    activeMultiAgentRounds.delete(sessionId);
    d.broadcast({ type: 'session_round_done', sessionId });
    if (!wasCancelled) {
      drainQueue(sessionId, agentId);
    }
  }
}

async function runAdvisorTurn(
  ws: WebSocketLike | null,
  session: SessionRow,
  primary: EnrichedAgent,
  advisor: EnrichedAgent,
  roundState: RoundState,
): Promise<void> {
  const d = getDeps();
  const S = d.stmts;
  const config = d.getConfig();
  const sessionId = session.id;
  const assistantMsgId = uuidv4();

  const primaryFound = findAgent(primary.id);
  const sessionProject = primaryFound?.project;

  const enrichedPrompt = d.buildEnrichedPrompt(advisor);
  const crossProjectNote =
    advisor.projectId && primary.projectId && advisor.projectId !== primary.projectId
      ? `\nYou are attached from project **${advisor.projectName || advisor.projectId}** but this session's workspace belongs to **${primary.projectName || primary.projectId}**. Review the code at the session cwd, not your home project.\n`
      : '';
  const advisorSystemPrompt = `${enrichedPrompt}

## Multi-Agent Session — Advisory Role
You are an **advisory participant** in a multi-agent session. The primary agent ("${primary.name}") owns execution.${crossProjectNote}
**Do not edit files, run mutating shell commands, commit, or push code.** Read the codebase and transcript, then provide context, review, and feedback on the primary agent's changes.`;

  const history = S.getMessages.all(sessionId) as MessageRow[];
  const transcript = history
    .map((m) => {
      if (m.role === 'user') return `[User]: ${m.content}`;
      const name = m.agent_name || (m.role === 'assistant' ? primary.name : 'System');
      return `[${name}]: ${m.content}`;
    })
    .join('\n\n');

  const userPrompt = transcript
    ? `${transcript}\n\nRespond to the conversation above. You are ${advisor.name} (advisor — read-only).`
    : 'Review the session context.';

  const engine = normalizeSessionMultiEngine(advisor.engine);
  const roomOwnerId = getWsAuthUserId(ws as unknown as AuthStampedWs | null) || getOrgOwnerUserId();
  const model = resolveEffectiveModel(config, engine, {
    agentModel: advisor.model as string | undefined,
    ownerUserId: roomOwnerId,
  });

  d.broadcast({
    type: 'thinking',
    sessionId,
    agentId: advisor.id,
    agentName: advisor.name,
    agentColor: advisor.color,
    messageId: assistantMsgId,
  });

  // Advisors may belong to another project; always run against the session workspace.
  const cwd = session.worktree_path || primary.cwd || process.env.HOME || '/';
  const spawnEnv = { ...buildSpawnEnv(config, { userId: roomOwnerId }) };
  if (sessionProject && roomOwnerId) {
    mergeSkillCredentialSpawnEnv(spawnEnv, {
      ownerId: roomOwnerId,
      agentId: advisor.id,
      project: sessionProject,
    });
    mergeProjectSecretsSpawnEnv(spawnEnv, { projectId: sessionProject.id, sessionId });
    mergeProjectAwsSpawnEnv(spawnEnv, sessionProject);
  }

  const result = await new Promise<string>((resolve, reject) => {
    const timeout = config.conferenceTimeoutMs;

    const planAndSpawn = async (): Promise<void> => {
      let cursorChatId: string | null = null;
      if (engine === 'cursor-agent') {
        try {
          cursorChatId = await createAdvisorCursorChat(d.getCursorBin(), cwd, spawnEnv);
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }

      let bin: string;
      let args: string[];
      let stdinPrompt: string | null;
      try {
        const plan = buildSessionMultiSpawnArgs({
          engine,
          model,
          systemPrompt: advisorSystemPrompt,
          userPrompt,
          cursorChatId,
          bins: {
            claude: d.getClaudeBin(),
            cursor: d.getCursorBin(),
            gemini: d.getGeminiBin(),
            codex: d.getCodexBin(),
          },
          logTag: `session ${sessionId} advisor ${advisor.id}`,
          codexDangerBypass: !!config.codexDangerBypass,
          advisory: true,
        });
        bin = plan.bin;
        args = plan.args;
        stdinPrompt = plan.stdinPrompt;
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const parser = createStreamParser(engine);
      let finalText = '';
      let partialFallback = '';
      let errorOutput = '';
      let streamErrorMessage = '';
      let spawnErrored = false;

      const childStdin: 'ignore' | 'pipe' = stdinPrompt !== null ? 'pipe' : 'ignore';
      const proc = spawn(bin, args, {
        cwd,
        env: spawnEnv,
        stdio: [childStdin, 'pipe', 'pipe'],
        detached: true,
      }) as ChildProcess;

      roundState.proc = proc;
      trackChild(proc);

      if (stdinPrompt !== null && proc.stdin) {
        try {
          proc.stdin.end(stdinPrompt, 'utf8');
        } catch {
          /* ignore */
        }
      }

      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGTERM');
        reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
      }, timeout);

      const handleEvent = (event: StreamEvent): void => {
        if (event.type === 'assistant_text') {
          const text =
            typeof event.text === 'string' ? event.text : JSON.stringify(event.text ?? '');
          if (event.replacesAssistantBuffer) {
            finalText = text;
            partialFallback = '';
          } else if (event.partial) {
            partialFallback += text;
          } else {
            finalText += text;
          }
          d.broadcast({
            type: 'stream',
            sessionId,
            agentId: advisor.id,
            agentName: advisor.name,
            agentColor: advisor.color,
            messageId: assistantMsgId,
            content: finalText || partialFallback,
          });
        }
        if (event.type === 'result' && event.isError && event.text) {
          if (!streamErrorMessage) streamErrorMessage = event.text;
        }
      };

      proc.stdout!.on('data', (chunk: Buffer) => {
        for (const ev of parser.feed(chunk)) handleEvent(ev);
      });
      proc.stderr!.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        roundState.proc = null;
        if (roundState.cancelled) {
          reject(new Error('Cancelled'));
          return;
        }
        if (spawnErrored) return;
        for (const ev of parser.flush()) handleEvent(ev);
        const assembled = (finalText || partialFallback).trim();
        if (code !== 0 && !assembled) {
          reject(new Error(streamErrorMessage || errorOutput.trim() || `Exited with code ${code}`));
        } else {
          resolve(assembled || errorOutput.trim() || '(empty response)');
        }
      });
      proc.on('error', (err: Error) => {
        spawnErrored = true;
        clearTimeout(timer);
        roundState.proc = null;
        reject(err);
      });
    };

    planAndSpawn().catch((err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  }).catch((err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (roundState.cancelled) return '(cancelled)';
    d.broadcast({
      type: 'error',
      sessionId,
      agentId: advisor.id,
      agentName: advisor.name,
      messageId: assistantMsgId,
      error: errMsg,
    });
    return `Error: ${errMsg}`;
  });

  S.addMessage.run(
    assistantMsgId,
    sessionId,
    'assistant',
    result,
    engine,
    model,
    null,
    null,
    advisor.id,
    advisor.name,
    advisor.color ?? null,
  );
  S.touchSession.run(sessionId);

  d.broadcast({
    type: 'message',
    message: {
      id: assistantMsgId,
      session_id: sessionId,
      role: 'assistant',
      agent_id: advisor.id,
      agent_name: advisor.name,
      agent_color: advisor.color,
      content: result,
      engine,
      model,
      created_at: new Date().toISOString(),
    },
  });
  d.broadcast({ type: 'done', sessionId, agentId: advisor.id, agentName: advisor.name });
}

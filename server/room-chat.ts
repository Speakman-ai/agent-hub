import { spawn, execFile, type ChildProcess } from 'child_process';
import { trackChild, killProcessGroup } from './process-groups.js';
import { v4 as uuidv4 } from 'uuid';
import { buildSpawnEnv } from './config.js';
import { resolveEffectiveModel } from './effective-model.js';
import { getProjects } from './project-model.js';
import { mergeSkillCredentialSpawnEnv } from './skill-credentials-spawn.js';
import { getWsAuthUserId, getOrgOwnerUserId, type AuthStampedWs } from './session-ownership.js';
import { createStreamParser } from './stream-parser.js';
import { buildRoomSpawnArgs, normalizeRoomEngine } from './room-multi-engine.js';
import type {
  Stmts,
  EnrichedAgent,
  RoomRow,
  RoomAgentRow,
  RoomMessageRow,
  RoomMessageQueueRow,
  AppConfig,
  BroadcastFn,
  StreamEvent,
} from './types.js';

// ─── Dependency Types ────────────────────────────────────────────────

interface RoomChatDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  buildEnrichedPrompt: (agent: EnrichedAgent) => string;
  getClaudeBin: () => string;
  getCursorBin: () => string;
  getGeminiBin: () => string;
  getCodexBin: () => string;
  getDefaultModel: () => string;
  getConfig: () => AppConfig;
  getMaxQueueSize: () => number;
}

interface RoomState {
  proc: ChildProcess | null;
  cancelled: boolean;
}

interface RoomChatMsg {
  roomId: string;
  content: string;
  _fromQueue?: boolean;
}

interface WebSocketLike {
  send: (data: string) => void;
}

// ─── Module-level state ──────────────────────────────────────────────
let deps: RoomChatDeps | null = null;

function getDeps(): RoomChatDeps {
  if (!deps) throw new Error('room-chat: initRoomChat() must be called before use');
  return deps;
}

export const activeRoomProcesses = new Map<string, RoomState>();

const drainingRoomLock = new Set<string>();

// ─── Initialisation ──────────────────────────────────────────────────

export function initRoomChat(d: RoomChatDeps): void {
  deps = d;
}

// ─── @Mention parsing ────────────────────────────────────────────────

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

// ─── Cursor chat creation (rooms are stateless, fresh chat per turn) ─

function createRoomCursorChat(cursorBin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cursorBin, ['create-chat'], { cwd, env: process.env }, (err, stdout, stderr) => {
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

// ─── Cancel & Queue helpers ──────────────────────────────────────────

export function handleRoomCancel(roomId: string): void {
  const d = getDeps();
  const state = activeRoomProcesses.get(roomId);
  if (state) {
    state.cancelled = true;
    if (state.proc) killProcessGroup(state.proc, 'SIGTERM');
  }
  try {
    d.stmts.clearRoomQueue.run(roomId);
    d.broadcast({ type: 'room_queue_updated', roomId, queue: [] });
  } catch {
    // best-effort
  }
}

export function handleRoomDequeue(roomId: string, messageId: string): void {
  const d = getDeps();
  try {
    d.stmts.dequeueRoomMessage.run(messageId);
    d.broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: d.stmts.getQueuedRoomMessages.all(roomId),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[room-dequeue] Error:', msg);
  }
}

function drainRoomQueue(roomId: string): void {
  const d = getDeps();
  if (drainingRoomLock.has(roomId)) return;
  drainingRoomLock.add(roomId);
  try {
    const next = d.stmts.getNextQueuedRoomMessage.get(roomId) as RoomMessageQueueRow | undefined;
    if (!next) return;
    d.stmts.dequeueRoomMessage.run(next.id);
    d.broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: d.stmts.getQueuedRoomMessages.all(roomId),
    });
    handleRoomChat(null, { roomId, content: next.content, _fromQueue: true }).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[room-drain] Error:', msg);
      },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[room-drain] Error:', msg);
  } finally {
    drainingRoomLock.delete(roomId);
  }
}

// ─── Main handler ────────────────────────────────────────────────────

export async function handleRoomChat(ws: WebSocketLike | null, msg: RoomChatMsg): Promise<void> {
  const { roomId, content } = msg;

  const d = getDeps();
  const S = d.stmts;
  const { broadcast, getEnrichedAgent, buildEnrichedPrompt } = d;
  const CLAUDE_BIN = d.getClaudeBin();
  const CURSOR_BIN = d.getCursorBin();
  const GEMINI_BIN = d.getGeminiBin();
  const CODEX_BIN = d.getCodexBin();
  const config = d.getConfig();
  const MAX_QUEUE_SIZE = d.getMaxQueueSize();

  const room = S.getRoom.get(roomId) as RoomRow | undefined;
  if (!room) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown room: ${roomId}` }));
    return;
  }

  const roomAgentRows = S.getRoomAgents.all(roomId) as RoomAgentRow[];
  if (roomAgentRows.length === 0) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: 'No agents in this room' }));
    return;
  }

  // ── Queue if room is already processing ──────────────────────────
  if (activeRoomProcesses.has(roomId) && !msg._fromQueue) {
    const currentQueue = S.getQueuedRoomMessages.all(roomId) as RoomMessageQueueRow[];
    if (currentQueue.length >= MAX_QUEUE_SIZE) {
      if (ws)
        ws.send(
          JSON.stringify({
            type: 'error',
            error: `Room queue is full (max ${MAX_QUEUE_SIZE} messages). Wait for current round to complete.`,
          }),
        );
      return;
    }

    const queueMsgId = uuidv4();
    const maxPos = S.getMaxRoomQueuePosition.get(roomId) as { max_pos: number | null } | undefined;
    const position = (maxPos?.max_pos ?? -1) + 1;

    S.addRoomMessage.run(queueMsgId, roomId, 'user', null, null, null, content, null);
    S.touchRoom.run(roomId);

    S.enqueueRoomMessage.run(queueMsgId, roomId, content, position);

    broadcast({
      type: 'room_message',
      roomId,
      message: {
        id: queueMsgId,
        room_id: roomId,
        role: 'user',
        agent_id: null,
        agent_name: null,
        agent_color: null,
        content,
        queued: true,
        created_at: new Date().toISOString(),
      },
    });

    broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: S.getQueuedRoomMessages.all(roomId),
    });

    return;
  }

  const resolvedAgents = roomAgentRows
    .map((ra) => getEnrichedAgent(ra.agent_id))
    .filter((a): a is EnrichedAgent => !!a);

  if (!msg._fromQueue) {
    const userMsgId = uuidv4();
    S.addRoomMessage.run(userMsgId, roomId, 'user', null, null, null, content, null);
    S.touchRoom.run(roomId);

    broadcast({
      type: 'room_message',
      roomId,
      message: {
        id: userMsgId,
        room_id: roomId,
        role: 'user',
        agent_id: null,
        agent_name: null,
        agent_color: null,
        content,
        created_at: new Date().toISOString(),
      },
    });
  }

  const history = S.getRoomMessages.all(roomId) as RoomMessageRow[];

  const roomState: RoomState = { proc: null, cancelled: false };
  activeRoomProcesses.set(roomId, roomState);

  const userMentions = parseMentions(content, resolvedAgents);
  const queue: EnrichedAgent[] =
    userMentions.size > 0
      ? resolvedAgents.filter((a) => userMentions.has(a.id))
      : [...resolvedAgents];

  try {
    S.insertActiveRoomTask.run(
      roomId,
      queue[0]?.id || null,
      queue[0]?.name || null,
      queue[0]?.color || null,
      null,
      JSON.stringify(queue.map((a) => a.id)),
      0,
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[room-task] Failed to insert active_room_tasks:', errMsg);
  }

  const MAX_TURNS = room.max_turns || 10;
  let turnCount = 0;

  broadcast({ type: 'room_round_start', roomId, agentCount: queue.length });

  while (queue.length > 0 && (MAX_TURNS === 0 || turnCount < MAX_TURNS)) {
    if (roomState.cancelled) break;

    const agent = queue.shift()!;
    turnCount++;
    const assistantMsgId = uuidv4();

    try {
      S.updateActiveRoomTaskAgent.run(
        agent.id,
        agent.name,
        agent.color,
        assistantMsgId,
        turnCount,
        roomId,
      );
    } catch {
      // non-critical
    }

    const enrichedPrompt = buildEnrichedPrompt(agent);
    const otherAgents = resolvedAgents.filter((a) => a.id !== agent.id);
    const otherNames = otherAgents.map((a) => a.name).join(', ');

    const agentNameList = otherAgents
      .map((a) => `  - "${a.name}" → write exactly: @${a.name}`)
      .join('\n');

    const lastMsg = history[history.length - 1];
    const isFollowUp = lastMsg && lastMsg.role === 'assistant' && lastMsg.agent_id !== agent.id;
    const lastSpeaker = isFollowUp ? lastMsg.agent_name : null;

    const roomSystemPrompt = `${enrichedPrompt}

## Conference Room — "${room.name}"
This is a multi-agent discussion. A system reads your text and triggers any agent you @mention.
${otherNames ? `\nOther agents:\n${agentNameList}` : ''}
${isFollowUp ? `\n**${lastSpeaker} just spoke and mentioned you.** You are responding to them directly.` : ''}

### @Mention Format (IMPORTANT)
To get another agent's response, include their @name in your text. The system parses your output for @mentions.

FORMAT: @ExactAgentName (must match exactly, including spaces)
${otherAgents.length > 0 ? `EXAMPLE: "I think we should try X. @${otherAgents[0].name} does that work with your approach?"` : ''}

- Writing just the agent's name (without @) will NOT trigger them — the @ prefix is REQUIRED.
- If you have a question, disagreement, or need input: USE @mention.${isFollowUp ? `\n- Since ${lastSpeaker} directed this to you, consider whether you need to loop in another agent with @mention.` : ''}
- If the topic is settled or you have nothing to ask: respond without any @mentions to end the chain.

### Guidelines
- Be concise (a few paragraphs max).
- Build on prior points, don't repeat.
- Stay in character.`;

    const transcript = history
      .map((m) => {
        if (m.role === 'user') return `[User]: ${m.content}`;
        return `[${m.agent_name || 'Agent'}]: ${m.content}`;
      })
      .join('\n\n');

    const userPrompt = transcript
      ? `${transcript}\n\nRespond to the conversation above. You are ${agent.name}.`
      : content;

    const engine = normalizeRoomEngine(agent.engine);

    const roomOwnerId =
      getWsAuthUserId(ws as unknown as AuthStampedWs | null) || getOrgOwnerUserId();
    const model = resolveEffectiveModel(config, engine, {
      agentModel: agent.model as string | undefined,
      ownerUserId: roomOwnerId,
    });
    broadcast({
      type: 'room_thinking',
      roomId,
      agentId: agent.id,
      agentName: agent.name,
      agentColor: agent.color,
      messageId: assistantMsgId,
    });

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const timeout = config.conferenceTimeoutMs;

        const roomEnv = { ...buildSpawnEnv(config, { userId: roomOwnerId }) };
        if (room.project_id && roomOwnerId) {
          const proj = getProjects().find((p) => p.id === room.project_id);
          if (proj) {
            mergeSkillCredentialSpawnEnv(roomEnv, {
              ownerId: roomOwnerId,
              agentId: agent.id,
              project: proj,
            });
          }
        }

        // cursor-agent requires a chat id to `--resume` against. Rooms do
        // not persist `engine_session_id` between turns, so each turn mints
        // a fresh chat. The await-via-Promise pattern keeps the spawn site
        // synchronous-looking; createRoomCursorChat is awaited inline.
        const planAndSpawn = async (): Promise<void> => {
          let cursorChatId: string | null = null;
          if (engine === 'cursor-agent') {
            try {
              cursorChatId = await createRoomCursorChat(
                CURSOR_BIN,
                agent.cwd || process.env.HOME || '/',
              );
            } catch (err: unknown) {
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            if (roomState.cancelled) {
              reject(new Error('Cancelled'));
              return;
            }
          }

          let bin: string;
          let args: string[];
          let stdinPrompt: string | null;
          try {
            const plan = buildRoomSpawnArgs({
              engine,
              model,
              systemPrompt: roomSystemPrompt,
              userPrompt,
              cursorChatId,
              bins: {
                claude: CLAUDE_BIN,
                cursor: CURSOR_BIN,
                gemini: GEMINI_BIN,
                codex: CODEX_BIN,
              },
              logTag: `room ${roomId} agent ${agent.id}`,
              codexDangerBypass: !!config.codexDangerBypass,
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
            cwd: agent.cwd || process.env.HOME,
            env: roomEnv,
            stdio: [childStdin, 'pipe', 'pipe'],
            detached: true,
          }) as ChildProcess;

          roomState.proc = proc;
          trackChild(proc);

          if (stdinPrompt !== null && proc.stdin) {
            try {
              proc.stdin.end(stdinPrompt, 'utf8');
            } catch (err) {
              console.error(
                `[room] failed to write stdin prompt for ${engine} (room ${roomId}):`,
                err instanceof Error ? err.message : err,
              );
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
              const visible = finalText || partialFallback;
              try {
                S.appendActiveRoomTaskOutput.run(visible, roomId);
              } catch {
                // non-critical
              }
              broadcast({
                type: 'room_stream',
                roomId,
                agentId: agent.id,
                agentName: agent.name,
                agentColor: agent.color,
                messageId: assistantMsgId,
                content: visible,
              });
            }

            if (event.type === 'result' && event.isError && event.text) {
              if (!streamErrorMessage) streamErrorMessage = event.text;
            }
            if (
              event.type === 'unknown' &&
              typeof event.text === 'string' &&
              (event.text.startsWith('codex error:') || event.text.startsWith('codex item error:'))
            ) {
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
            roomState.proc = null;
            if (roomState.cancelled) {
              reject(new Error('Cancelled'));
              return;
            }
            if (spawnErrored) {
              // proc.on('error') already rejected with the useful message
              return;
            }
            for (const ev of parser.flush()) handleEvent(ev);
            const assembled = (finalText || partialFallback).trim();
            if (code !== 0 && !assembled) {
              const errMsg = streamErrorMessage || errorOutput.trim() || `Exited with code ${code}`;
              reject(new Error(errMsg));
            } else {
              resolve(assembled || errorOutput.trim() || '(empty response)');
            }
          });

          proc.on('error', (err: Error) => {
            spawnErrored = true;
            clearTimeout(timer);
            roomState.proc = null;
            reject(err);
          });
        };

        planAndSpawn().catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });

      S.addRoomMessage.run(
        assistantMsgId,
        roomId,
        'assistant',
        agent.id,
        agent.name,
        agent.color,
        result,
        null,
      );
      S.touchRoom.run(roomId);

      history.push({
        id: assistantMsgId,
        room_id: roomId,
        role: 'assistant',
        agent_id: agent.id,
        agent_name: agent.name,
        agent_color: agent.color ?? null,
        content: result,
        attachments: null,
        created_at: new Date().toISOString(),
      });

      broadcast({
        type: 'room_agent_done',
        roomId,
        messageId: assistantMsgId,
        message: {
          id: assistantMsgId,
          room_id: roomId,
          role: 'assistant',
          agent_id: agent.id,
          agent_name: agent.name,
          agent_color: agent.color,
          content: result,
          created_at: new Date().toISOString(),
        },
      });

      const newMentions = parseMentions(result, resolvedAgents);
      newMentions.delete(agent.id);
      const queuedIds = new Set(queue.map((a) => a.id));
      for (const mentionedId of newMentions) {
        if (!queuedIds.has(mentionedId)) {
          const mentionedAgent = resolvedAgents.find((a) => a.id === mentionedId);
          if (mentionedAgent) {
            queue.push(mentionedAgent);
            queuedIds.add(mentionedId);
          }
        }
      }
    } catch (err: unknown) {
      if (roomState.cancelled) {
        broadcast({ type: 'room_cancelled', roomId });
        break;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({
        type: 'room_agent_error',
        roomId,
        agentId: agent.id,
        agentName: agent.name,
        messageId: assistantMsgId,
        error: errMsg,
      });
    }
  }

  const wasCancelled = activeRoomProcesses.get(roomId)?.cancelled;
  activeRoomProcesses.delete(roomId);
  try {
    S.deleteActiveRoomTask.run(roomId);
  } catch {
    // non-critical
  }

  let remainingQueue: RoomMessageQueueRow[] = [];
  try {
    remainingQueue = S.getQueuedRoomMessages.all(roomId) as RoomMessageQueueRow[];
  } catch {
    // non-critical
  }
  broadcast({ type: 'room_round_done', roomId, queueLength: remainingQueue.length });

  if (!wasCancelled) {
    drainRoomQueue(roomId);
  }
}

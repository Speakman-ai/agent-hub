import { spawn, type ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { buildSpawnEnv } from './config.js';
import { disableNativeSkillToolArgs } from './claude-cli-args.js';
import type {
  Stmts,
  EnrichedAgent,
  RoomRow,
  RoomAgentRow,
  RoomMessageRow,
  RoomMessageQueueRow,
  AppConfig,
  BroadcastFn,
} from './types.js';

// ─── Dependency Types ────────────────────────────────────────────────

interface RoomChatDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null;
  buildEnrichedPrompt: (agent: EnrichedAgent) => string;
  getClaudeBin: () => string;
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

// ─── Cancel & Queue helpers ──────────────────────────────────────────

export function handleRoomCancel(roomId: string): void {
  const d = getDeps();
  const state = activeRoomProcesses.get(roomId);
  if (state) {
    state.cancelled = true;
    if (state.proc) state.proc.kill('SIGTERM');
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
  const DEFAULT_MODEL = d.getDefaultModel();
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
        const model = (agent.model as string | undefined) || DEFAULT_MODEL;
        const args: string[] = [
          '--print',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          model,
          '--system-prompt',
          roomSystemPrompt,
          // see claude-cli-args.ts
          ...disableNativeSkillToolArgs(),
          // `--` terminates option parsing so the variadic `--disallowed-tools <tools...>`
          // doesn't swallow the trailing positional prompt (Claude CLI 2.x).
          '--',
          userPrompt,
        ];

        let output = '';
        let errorOutput = '';
        const timeout = config.conferenceTimeoutMs;

        const roomEnv = buildSpawnEnv(config);

        const proc = spawn(CLAUDE_BIN, args, {
          cwd: agent.cwd || process.env.HOME,
          env: roomEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as ChildProcess;

        roomState.proc = proc;

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
        }, timeout);

        proc.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          try {
            S.appendActiveRoomTaskOutput.run(output, roomId);
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
            content: output,
          });
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
          if (code !== 0 && !output) {
            reject(new Error(errorOutput || `Exited with code ${code}`));
          } else {
            resolve(output.trim() || errorOutput.trim() || '(empty response)');
          }
        });

        proc.on('error', (err: Error) => {
          clearTimeout(timer);
          roomState.proc = null;
          reject(err);
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

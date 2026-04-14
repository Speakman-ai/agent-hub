/**
 * Conference Room Chat Engine
 *
 * Handles multi-agent conversation orchestration: turn-taking logic,
 * room message broadcasting, @mention parsing, agent response coordination,
 * queue management, and CLI process spawning for room conversations.
 */

import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// ─── Module-level state ──────────────────────────────────────────────
let deps = null;

/** Active room processes (keyed by roomId). */
export const activeRoomProcesses = new Map(); // roomId -> { proc, cancelled }

/** Prevents double-drain race for rooms. */
const drainingRoomLock = new Set();

// ─── Initialisation ──────────────────────────────────────────────────

/**
 * Call once at startup to inject shared dependencies.
 *
 * @param {object} d
 * @param {object} d.stmts               - Prepared SQLite statements
 * @param {Function} d.broadcast          - WebSocket broadcast helper
 * @param {Function} d.getEnrichedAgent   - Resolve agent by ID (enriched with project data)
 * @param {Function} d.buildEnrichedPrompt - Build the full system prompt for an agent
 * @param {Function} d.getClaudeBin       - Returns the current CLAUDE_BIN path
 * @param {Function} d.getDefaultModel    - Returns the current DEFAULT_MODEL string
 * @param {Function} d.getConfig          - Returns the server config object
 * @param {Function} d.getMaxQueueSize    - Returns the max queue size constant
 */
export function initRoomChat(d) {
  deps = d;
}

// ─── @Mention parsing ────────────────────────────────────────────────

/**
 * Parse @mentions from text and return the set of mentioned agent ids.
 * Matches @AgentName (case-insensitive) against the provided agent list.
 * Sorts matches longest-name-first so "Code Review" matches before "Code".
 */
export function parseMentions(text, agentList) {
  const mentioned = new Set();
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

/**
 * Cancel an active room process and clear its queue.
 */
export function handleRoomCancel(roomId) {
  const state = activeRoomProcesses.get(roomId);
  if (state) {
    state.cancelled = true;
    if (state.proc) state.proc.kill('SIGTERM');
  }
  // Clear queued messages so drain doesn't pick them up after cancellation
  try {
    deps.stmts.clearRoomQueue.run(roomId);
    deps.broadcast({ type: 'room_queue_updated', roomId, queue: [] });
  } catch {}
}

/**
 * Remove a specific message from the room queue.
 */
export function handleRoomDequeue(roomId, messageId) {
  try {
    deps.stmts.dequeueRoomMessage.run(messageId);
    deps.broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: deps.stmts.getQueuedRoomMessages.all(roomId),
    });
  } catch (err) {
    console.error('[room-dequeue] Error:', err.message);
  }
}

/**
 * Drain room message queue — process the next queued message after a round completes.
 */
function drainRoomQueue(roomId) {
  if (drainingRoomLock.has(roomId)) return;
  drainingRoomLock.add(roomId);
  try {
    const next = deps.stmts.getNextQueuedRoomMessage.get(roomId);
    if (!next) return;
    // Remove from queue
    deps.stmts.dequeueRoomMessage.run(next.id);
    deps.broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: deps.stmts.getQueuedRoomMessages.all(roomId),
    });
    // Fire-and-forget — release lock immediately so the next drain (triggered
    // at the end of handleRoomChat) can proceed for subsequent queued messages.
    handleRoomChat(null, { roomId, content: next.content, _fromQueue: true }).catch((err) => {
      console.error('[room-drain] Error:', err.message);
    });
  } catch (err) {
    console.error('[room-drain] Error:', err.message);
  } finally {
    drainingRoomLock.delete(roomId);
  }
}

// ─── Main handler ────────────────────────────────────────────────────

/**
 * Handle a conference room chat message.
 *
 * Orchestrates multi-agent conversations: resolves agents, manages the turn queue,
 * spawns CLI processes for each agent, streams output, parses @mentions to chain
 * further agents, and drains the message queue when a round completes.
 *
 * @param {WebSocket|null} ws - WebSocket connection (null when replaying from queue)
 * @param {object} msg - Message object { roomId, content, _fromQueue? }
 */
export async function handleRoomChat(ws, msg) {
  const { roomId, content } = msg;

  // Pin DB statements so org switches don't corrupt in-flight room processes
  const S = deps.stmts;
  const { broadcast, getEnrichedAgent, buildEnrichedPrompt } = deps;
  const CLAUDE_BIN = deps.getClaudeBin();
  const DEFAULT_MODEL = deps.getDefaultModel();
  const config = deps.getConfig();
  const MAX_QUEUE_SIZE = deps.getMaxQueueSize();

  const room = S.getRoom.get(roomId);
  if (!room) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: `Unknown room: ${roomId}` }));
    return;
  }

  const roomAgentRows = S.getRoomAgents.all(roomId);
  if (roomAgentRows.length === 0) {
    if (ws) ws.send(JSON.stringify({ type: 'error', error: 'No agents in this room' }));
    return;
  }

  // ── Queue if room is already processing ──────────────────────────
  if (activeRoomProcesses.has(roomId) && !msg._fromQueue) {
    const currentQueue = S.getQueuedRoomMessages.all(roomId);
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
    const maxPos = S.getMaxRoomQueuePosition.get(roomId);
    const position = (maxPos?.max_pos ?? -1) + 1;

    // Save user message so it appears in room history
    S.addRoomMessage.run(queueMsgId, roomId, 'user', null, null, null, content, null);
    S.touchRoom.run(roomId);

    // Add to queue
    S.enqueueRoomMessage.run(queueMsgId, roomId, content, position);

    // Broadcast user message with queued flag
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

    // Broadcast updated queue
    broadcast({
      type: 'room_queue_updated',
      roomId,
      queue: S.getQueuedRoomMessages.all(roomId),
    });

    return;
  }

  // Resolve all room agents (enriched with project fields)
  const resolvedAgents = roomAgentRows.map((ra) => getEnrichedAgent(ra.agent_id)).filter(Boolean);

  // Save & broadcast user message (skip if replaying from queue — already saved)
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

  // Build conversation transcript for context
  const history = S.getRoomMessages.all(roomId);

  // Track cancellation state (in-memory for process control)
  const roomState = { proc: null, cancelled: false };
  activeRoomProcesses.set(roomId, roomState);

  // Determine initial queue: @mentioned agents, or all agents if no mentions
  const userMentions = parseMentions(content, resolvedAgents);
  const queue =
    userMentions.size > 0
      ? resolvedAgents.filter((a) => userMentions.has(a.id))
      : [...resolvedAgents];

  // Insert DB-backed task record for reconnection
  try {
    S.insertActiveRoomTask.run(
      roomId,
      queue[0]?.id || null,
      queue[0]?.name || null,
      queue[0]?.color || null,
      null, // message_id set per agent turn
      JSON.stringify(queue.map((a) => a.id)),
      0,
    );
  } catch (err) {
    console.error('[room-task] Failed to insert active_room_tasks:', err.message);
  }

  // 0 = unlimited; otherwise cap at the room's configured max
  const MAX_TURNS = room.max_turns || 10;
  let turnCount = 0;

  broadcast({ type: 'room_round_start', roomId, agentCount: queue.length });

  while (queue.length > 0 && (MAX_TURNS === 0 || turnCount < MAX_TURNS)) {
    if (roomState.cancelled) break;

    const agent = queue.shift();
    turnCount++;
    const assistantMsgId = uuidv4();

    // Update DB task with current agent
    try {
      S.updateActiveRoomTaskAgent.run(
        agent.id,
        agent.name,
        agent.color,
        assistantMsgId,
        turnCount,
        roomId,
      );
    } catch {}

    // Build system prompt: agent identity + room context + mention instructions
    const enrichedPrompt = buildEnrichedPrompt(agent);
    const otherAgents = resolvedAgents.filter((a) => a.id !== agent.id);
    const otherNames = otherAgents.map((a) => a.name).join(', ');

    const agentNameList = otherAgents
      .map((a) => `  - "${a.name}" → write exactly: @${a.name}`)
      .join('\n');

    // Detect if this is a follow-up (agent responding to another agent, not the user)
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

    // Build the transcript as the prompt
    const transcript = history
      .map((m) => {
        if (m.role === 'user') return `[User]: ${m.content}`;
        return `[${m.agent_name || 'Agent'}]: ${m.content}`;
      })
      .join('\n\n');

    const userPrompt = transcript
      ? `${transcript}\n\nRespond to the conversation above. You are ${agent.name}.`
      : content;

    // Broadcast thinking
    broadcast({
      type: 'room_thinking',
      roomId,
      agentId: agent.id,
      agentName: agent.name,
      agentColor: agent.color,
      messageId: assistantMsgId,
    });

    // Run agent and stream response
    try {
      const result = await new Promise((resolve, reject) => {
        const args = [
          '--print',
          '--permission-mode',
          'bypassPermissions',
          '--model',
          agent.model || DEFAULT_MODEL,
          '--system-prompt',
          roomSystemPrompt,
          userPrompt,
        ];

        let output = '';
        let errorOutput = '';
        const timeout = config.conferenceTimeoutMs; // configurable, default 10 min

        const roomEnv = { ...process.env };
        if (config.anthropicApiKey) {
          roomEnv.ANTHROPIC_API_KEY = config.anthropicApiKey;
        }

        const proc = spawn(CLAUDE_BIN, args, {
          cwd: agent.cwd || process.env.HOME,
          env: roomEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        roomState.proc = proc;

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error(`Timed out after ${Math.round(timeout / 60000)} minutes`));
        }, timeout);

        proc.stdout.on('data', (chunk) => {
          output += chunk.toString();
          // Update DB with streamed output for reconnection
          try {
            S.appendActiveRoomTaskOutput.run(output, roomId);
          } catch {}
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

        proc.stderr.on('data', (chunk) => {
          errorOutput += chunk.toString();
        });

        proc.on('close', (code) => {
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

        proc.on('error', (err) => {
          clearTimeout(timer);
          roomState.proc = null;
          reject(err);
        });
      });

      // Save agent message
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

      // Add to running history so next agent sees it
      history.push({
        id: assistantMsgId,
        room_id: roomId,
        role: 'assistant',
        agent_id: agent.id,
        agent_name: agent.name,
        agent_color: agent.color,
        content: result,
        created_at: new Date().toISOString(),
      });

      // Broadcast done for this agent
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

      // Check if this agent @mentioned other agents → chain them in
      const newMentions = parseMentions(result, resolvedAgents);
      // Don't let an agent re-summon itself
      newMentions.delete(agent.id);
      // Add mentioned agents to queue if not already queued
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
    } catch (err) {
      if (roomState.cancelled) {
        broadcast({ type: 'room_cancelled', roomId });
        break;
      }
      broadcast({
        type: 'room_agent_error',
        roomId,
        agentId: agent.id,
        agentName: agent.name,
        messageId: assistantMsgId,
        error: err.message,
      });
    }
  }

  // Clean up in-memory and DB tracking
  const wasCancelled = activeRoomProcesses.get(roomId)?.cancelled;
  activeRoomProcesses.delete(roomId);
  try {
    S.deleteActiveRoomTask.run(roomId);
  } catch {}

  // Include queue length so client knows whether to keep roomProcessing=true
  let remainingQueue = [];
  try {
    remainingQueue = S.getQueuedRoomMessages.all(roomId);
  } catch {}
  broadcast({ type: 'room_round_done', roomId, queueLength: remainingQueue.length });

  // Drain queued messages — process the next one if any (skip if cancelled)
  if (!wasCancelled) {
    drainRoomQueue(roomId);
  }
}

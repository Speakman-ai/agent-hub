import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
  RouteDeps,
  RoomRow,
  RoomAgentRow,
  RoomMessageRow,
  EnrichedAgent,
  RoomAgentDetail,
} from '../types.js';

interface RoomAgentInfo {
  id: string;
  name: string;
  color: string;
  position: number;
}

function mapRoomAgents(
  roomAgents: RoomAgentRow[],
  getEnrichedAgent: (agentId: string) => EnrichedAgent | null,
): RoomAgentInfo[] {
  return roomAgents.map((ra) => {
    const agent = getEnrichedAgent(ra.agent_id);
    return agent
      ? { id: agent.id, name: agent.name, color: agent.color || '#666', position: ra.position }
      : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
  });
}

export default function createRoomRoutes(deps: RouteDeps): Router {
  const {
    stmts,
    getEnrichedAgent,
    findProject,
    ensureProjectRoom,
    buildTranscript,
    summarizeTranscript,
    DEFAULT_MODEL,
    config,
  } = deps;
  const router = Router();

  router.get('/api/rooms', (_req: Request, res: Response) => {
    const rooms = stmts.getRooms.all() as RoomRow[];
    const enriched = rooms.map((room) => {
      const roomAgents = stmts.getRoomAgents.all(room.id) as RoomAgentRow[];
      const agentDetails = mapRoomAgents(roomAgents, getEnrichedAgent);
      return { ...room, agents: agentDetails };
    });
    res.json(enriched);
  });

  router.get('/api/projects/:projectId/room', (req: Request, res: Response) => {
    const project = findProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const room = ensureProjectRoom(project);
    if (!room) return res.status(404).json({ error: 'No agents in project' });
    res.json(room);
  });

  router.post('/api/rooms', (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uuidv4();
    stmts.createRoom.run(id, name);
    const room = stmts.getRoom.get(id) as RoomRow;
    res.json({ ...room, agents: [] });
  });

  router.get('/api/rooms/:id', (req: Request, res: Response) => {
    const room = stmts.getRoom.get(req.params.id) as RoomRow | undefined;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const roomAgents = stmts.getRoomAgents.all(room.id) as RoomAgentRow[];
    const agentDetails = mapRoomAgents(roomAgents, getEnrichedAgent);
    res.json({ ...room, agents: agentDetails });
  });

  router.patch('/api/rooms/:id', (req: Request, res: Response) => {
    const room = stmts.getRoom.get(req.params.id) as RoomRow | undefined;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { name, max_turns } = req.body as { name?: string; max_turns?: number };
    if (name) stmts.updateRoomName.run(name, room.id);
    if (max_turns !== undefined) stmts.updateRoomMaxTurns.run(max_turns, room.id);
    const updated = stmts.getRoom.get(room.id) as RoomRow;
    const roomAgents = stmts.getRoomAgents.all(room.id) as RoomAgentRow[];
    const agentDetails = mapRoomAgents(roomAgents, getEnrichedAgent);
    res.json({ ...updated, agents: agentDetails });
  });

  router.delete('/api/rooms/:id', (req: Request, res: Response) => {
    stmts.deleteRoom.run(req.params.id);
    res.json({ ok: true });
  });

  router.post('/api/rooms/:id/agents', (req: Request, res: Response) => {
    const room = stmts.getRoom.get(req.params.id) as RoomRow | undefined;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { agentId } = req.body as { agentId?: string };
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    stmts.addRoomAgent.run(room.id, agentId, room.id);
    const roomAgents = stmts.getRoomAgents.all(room.id) as RoomAgentRow[];
    const agentDetails = mapRoomAgents(roomAgents, getEnrichedAgent);
    res.json(agentDetails);
  });

  router.delete('/api/rooms/:id/agents/:agentId', (req: Request, res: Response) => {
    stmts.removeRoomAgent.run(req.params.id, req.params.agentId);
    res.json({ ok: true });
  });

  router.get('/api/rooms/:id/messages', (req: Request, res: Response) => {
    const messages = stmts.getRoomMessages.all(req.params.id) as RoomMessageRow[];
    res.json(messages);
  });

  router.post('/api/rooms/:id/summarize', async (req: Request, res: Response) => {
    try {
      const room = (stmts.getRoom as { get?: (id: string) => RoomRow | undefined })?.get?.(
        req.params.id as string,
      );
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const messages = stmts.getRoomMessages.all(req.params.id) as RoomMessageRow[];
      if (!messages.length) return res.status(400).json({ error: 'No messages to summarize' });

      const transcript = buildTranscript(messages, { isRoom: true });

      const summary = await summarizeTranscript(
        transcript,
        { engine: 'claude-code', model: DEFAULT_MODEL },
        config,
      );

      res.json({ summary });
    } catch (err) {
      console.error('Summarize room error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

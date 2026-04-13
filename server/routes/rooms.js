import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

export default function createRoomRoutes(deps) {
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

  router.get('/api/rooms', (_req, res) => {
    const rooms = stmts.getRooms.all();
    const enriched = rooms.map((room) => {
      const roomAgents = stmts.getRoomAgents.all(room.id);
      const agentDetails = roomAgents.map((ra) => {
        const agent = getEnrichedAgent(ra.agent_id);
        return agent
          ? { id: agent.id, name: agent.name, color: agent.color, position: ra.position }
          : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
      });
      return { ...room, agents: agentDetails };
    });
    res.json(enriched);
  });

  router.get('/api/projects/:projectId/room', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const room = ensureProjectRoom(project);
    if (!room) return res.status(404).json({ error: 'No agents in project' });
    res.json(room);
  });

  router.post('/api/rooms', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uuidv4();
    stmts.createRoom.run(id, name);
    const room = stmts.getRoom.get(id);
    res.json({ ...room, agents: [] });
  });

  router.get('/api/rooms/:id', (req, res) => {
    const room = stmts.getRoom.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const roomAgents = stmts.getRoomAgents.all(room.id);
    const agentDetails = roomAgents.map((ra) => {
      const agent = getEnrichedAgent(ra.agent_id);
      return agent
        ? { id: agent.id, name: agent.name, color: agent.color, position: ra.position }
        : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
    });
    res.json({ ...room, agents: agentDetails });
  });

  router.patch('/api/rooms/:id', (req, res) => {
    const room = stmts.getRoom.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { name, max_turns } = req.body;
    if (name) stmts.updateRoomName.run(name, room.id);
    if (max_turns !== undefined) stmts.updateRoomMaxTurns.run(max_turns, room.id);
    const updated = stmts.getRoom.get(room.id);
    const roomAgents = stmts.getRoomAgents.all(room.id);
    const agentDetails = roomAgents.map((ra) => {
      const agent = getEnrichedAgent(ra.agent_id);
      return agent
        ? { id: agent.id, name: agent.name, color: agent.color, position: ra.position }
        : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
    });
    res.json({ ...updated, agents: agentDetails });
  });

  router.delete('/api/rooms/:id', (req, res) => {
    stmts.deleteRoom.run(req.params.id);
    res.json({ ok: true });
  });

  router.post('/api/rooms/:id/agents', (req, res) => {
    const room = stmts.getRoom.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    stmts.addRoomAgent.run(room.id, agentId, room.id);
    const roomAgents = stmts.getRoomAgents.all(room.id);
    const agentDetails = roomAgents.map((ra) => {
      const agent = getEnrichedAgent(ra.agent_id);
      return agent
        ? { id: agent.id, name: agent.name, color: agent.color, position: ra.position }
        : { id: ra.agent_id, name: 'Unknown', color: '#666', position: ra.position };
    });
    res.json(agentDetails);
  });

  router.delete('/api/rooms/:id/agents/:agentId', (req, res) => {
    stmts.removeRoomAgent.run(req.params.id, req.params.agentId);
    res.json({ ok: true });
  });

  router.get('/api/rooms/:id/messages', (req, res) => {
    const messages = stmts.getRoomMessages.all(req.params.id);
    res.json(messages);
  });

  // Summarize a conference room conversation
  router.post('/api/rooms/:id/summarize', async (req, res) => {
    try {
      const room = stmts.getRoom?.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const messages = stmts.getRoomMessages.all(req.params.id);
      if (!messages.length) return res.status(400).json({ error: 'No messages to summarize' });

      const transcript = buildTranscript(messages, { isRoom: true });

      const summary = await summarizeTranscript(
        transcript,
        {
          engine: 'claude-code',
          model: DEFAULT_MODEL,
        },
        config,
      );

      res.json({ summary });
    } catch (err) {
      console.error('Summarize room error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

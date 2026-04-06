import React, { useState, useEffect } from 'react';
import { api } from '../utils/api.js';
import { relativeTime, relativeFuture } from '../utils/time.js';

function HeartbeatSection() {
  const [heartbeats, setHeartbeats] = useState([]);
  const [expandedAgent, setExpandedAgent] = useState(null);
  const [logs, setLogs] = useState({});
  const [running, setRunning] = useState({});
  // Tick every 30s so the "next run in Xm" badges decrement live without
  // hitting the network. Server is re-polled every 60s for fresh state.
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => api.getHeartbeats().then(setHeartbeats).catch(console.error);
    refresh();
    const pollId = setInterval(refresh, 60_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const loadLogs = async (agentId) => {
    if (expandedAgent === agentId) {
      setExpandedAgent(null);
      return;
    }
    setExpandedAgent(agentId);
    const data = await api.getHeartbeatLogs(agentId, 20);
    setLogs((prev) => ({ ...prev, [agentId]: data }));
  };

  const toggleHeartbeat = async (agentId, current) => {
    await api.updateHeartbeat(agentId, { enabled: !current });
    setHeartbeats((prev) =>
      prev.map((h) =>
        h.agentId === agentId
          ? { ...h, heartbeat: { ...h.heartbeat, enabled: !current } }
          : h
      )
    );
  };

  const triggerRun = async (agentId) => {
    setRunning((prev) => ({ ...prev, [agentId]: true }));
    try {
      await api.runHeartbeat(agentId);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [agentId]: false })), 3000);
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Agent Heartbeats</h3>
      <div className="space-y-3">
        {heartbeats.map((hb) => (
          <div key={hb.agentId} className="bg-gray-800 rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 p-4">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: hb.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{hb.agentName}</span>
                  <span className="text-xs text-gray-500 font-mono">
                    {hb.heartbeat.interval || 'not set'}
                  </span>
                  {hb.heartbeat.enabled && hb.state?.next_run_at && (() => {
                    const { label, overdue } = relativeFuture(hb.state.next_run_at);
                    return (
                      <span
                        title={`Next run: ${new Date(hb.state.next_run_at).toLocaleString()}`}
                        className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                          overdue
                            ? 'bg-amber-900/40 text-amber-400'
                            : 'bg-gray-700/60 text-gray-400'
                        }`}
                      >
                        {label}
                      </span>
                    );
                  })()}
                </div>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {hb.heartbeat.prompt || 'No prompt configured'}
                </p>
                {hb.latestLog && (
                  <p className="text-xs text-gray-600 mt-0.5">
                    Last run: {relativeTime(hb.latestLog.timestamp)} —{' '}
                    <span
                      className={
                        hb.latestLog.status === 'success'
                          ? 'text-emerald-500'
                          : hb.latestLog.status === 'error'
                          ? 'text-red-400'
                          : 'text-yellow-400'
                      }
                    >
                      {hb.latestLog.status}
                    </span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  onClick={() => triggerRun(hb.agentId)}
                  disabled={running[hb.agentId]}
                  className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors disabled:opacity-50 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                >
                  {running[hb.agentId] ? '⏳' : '▶'}
                </button>
                <button
                  onClick={() => toggleHeartbeat(hb.agentId, hb.heartbeat.enabled)}
                  className={`text-xs px-2.5 py-2 sm:py-1 rounded-md transition-colors min-h-[36px] sm:min-h-0 flex items-center ${
                    hb.heartbeat.enabled
                      ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  {hb.heartbeat.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => loadLogs(hb.agentId)}
                  className="text-xs text-gray-400 hover:text-white px-2 py-2 sm:py-1 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                >
                  {expandedAgent === hb.agentId ? '▲' : '▼'}
                </button>
              </div>
            </div>

            {expandedAgent === hb.agentId && (
              <div className="border-t border-gray-700 p-4 max-h-64 overflow-y-auto">
                {(logs[hb.agentId] || []).length === 0 ? (
                  <p className="text-xs text-gray-500">No logs yet</p>
                ) : (
                  <div className="space-y-2">
                    {(logs[hb.agentId] || []).map((log) => (
                      <div
                        key={log.id}
                        className="bg-gray-900 rounded-lg p-3 text-xs"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`px-1.5 py-0.5 rounded text-xs ${
                              log.status === 'success'
                                ? 'bg-emerald-900/50 text-emerald-400'
                                : log.status === 'error'
                                ? 'bg-red-900/50 text-red-400'
                                : 'bg-yellow-900/50 text-yellow-400'
                            }`}
                          >
                            {log.status}
                          </span>
                          <span className="text-gray-500">
                            {relativeTime(log.timestamp)}
                          </span>
                        </div>
                        <pre className="text-gray-300 whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">
                          {log.result || '(running...)'}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CronSection() {
  const [crons, setCrons] = useState([]);
  const [running, setRunning] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [, setTick] = useState(0);
  const [cronLogs, setCronLogs] = useState({});       // { [cronId]: log[] }
  const [expandedLog, setExpandedLog] = useState(null); // "cronId:logId"
  const [form, setForm] = useState({
    name: '',
    schedule: '',
    prompt: '',
    cwd: '/home/ryan',
    enabled: true,
  });

  /** Fetch last-3 logs for every cron */
  const refreshLogs = async (cronList) => {
    const entries = await Promise.all(
      (cronList || crons).map(async (c) => {
        try {
          const logs = await api.getCronLogs(c.id, 3);
          return [c.id, logs];
        } catch {
          return [c.id, []];
        }
      })
    );
    setCronLogs(Object.fromEntries(entries));
  };

  useEffect(() => {
    const refresh = async () => {
      try {
        const data = await api.getCrons();
        setCrons(data);
        await refreshLogs(data);
      } catch (e) {
        console.error(e);
      }
    };
    refresh();
    const pollId = setInterval(refresh, 60_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const toggleCron = async (cronJob) => {
    const updated = await api.updateCron(cronJob.id, {
      enabled: !cronJob.enabled,
    });
    setCrons((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const triggerRun = async (id) => {
    setRunning((prev) => ({ ...prev, [id]: true }));
    try {
      await api.runCron(id);
    } catch (e) {
      console.error(e);
    }
    setTimeout(() => setRunning((prev) => ({ ...prev, [id]: false })), 3000);
  };

  const deleteCron = async (id) => {
    await api.deleteCron(id);
    setCrons((prev) => prev.filter((c) => c.id !== id));
  };

  const createCron = async (e) => {
    e.preventDefault();
    const created = await api.createCron(form);
    setCrons((prev) => [...prev, created]);
    setShowForm(false);
    setForm({ name: '', schedule: '', prompt: '', cwd: '/home/ryan', enabled: true });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Cron Jobs</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          {showForm ? 'Cancel' : '+ New Cron'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={createCron}
          className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3"
        >
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Name"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <input
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            placeholder="Cron schedule (e.g. */30 * * * *)"
            required
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Prompt"
            required
            rows={3}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600 resize-none"
          />
          <input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            placeholder="Working directory"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
          />
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Create
          </button>
        </form>
      )}

      <div className="space-y-3">
        {crons.map((cronJob) => (
          <div key={cronJob.id} className="bg-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{cronJob.name}</span>
                  <span className="text-xs text-gray-500 font-mono">
                    {cronJob.schedule}
                  </span>
                  {cronJob.enabled && cronJob.next_run_at && (() => {
                    const { label, overdue } = relativeFuture(cronJob.next_run_at);
                    return (
                      <span
                        title={`Next run: ${new Date(cronJob.next_run_at).toLocaleString()}`}
                        className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                          overdue
                            ? 'bg-amber-900/40 text-amber-400'
                            : 'bg-gray-700/60 text-gray-400'
                        }`}
                      >
                        {label}
                      </span>
                    );
                  })()}
                </div>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {cronJob.prompt}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  cwd: {cronJob.cwd}
                  {cronJob.last_run && (
                    <> · Last: {relativeTime(cronJob.last_run)}</>
                  )}
                </p>
                {/* Recent runs — clickable status dots */}
                {cronLogs[cronJob.id]?.length > 0 && (
                  <div className="mt-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500 mr-0.5">Runs:</span>
                      {cronLogs[cronJob.id].map((log) => {
                        const key = `${cronJob.id}:${log.id}`;
                        const isExpanded = expandedLog === key;
                        const statusColor =
                          log.status === 'success'
                            ? 'bg-emerald-500'
                            : log.status === 'error'
                            ? 'bg-red-500'
                            : log.status === 'running'
                            ? 'bg-amber-400 animate-pulse'
                            : 'bg-gray-500';
                        const durationLabel = log.duration_ms != null
                          ? `${(log.duration_ms / 1000).toFixed(1)}s`
                          : '';
                        return (
                          <button
                            key={log.id}
                            onClick={() => setExpandedLog(isExpanded ? null : key)}
                            title={`${log.status} — ${new Date(log.timestamp).toLocaleString()}${durationLabel ? ` (${durationLabel})` : ''}`}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors ${
                              isExpanded
                                ? 'bg-gray-700 ring-1 ring-gray-500'
                                : 'bg-gray-800 hover:bg-gray-700'
                            }`}
                          >
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
                            <span className="text-gray-400">{relativeTime(log.timestamp)}</span>
                          </button>
                        );
                      })}
                    </div>
                    {/* Expanded log result */}
                    {cronLogs[cronJob.id].map((log) => {
                      const key = `${cronJob.id}:${log.id}`;
                      if (expandedLog !== key) return null;
                      return (
                        <div key={`detail-${log.id}`} className="mt-2 bg-gray-900 rounded-lg p-3 border border-gray-700/50">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-medium ${
                                log.status === 'success' ? 'text-emerald-400' :
                                log.status === 'error' ? 'text-red-400' :
                                log.status === 'running' ? 'text-amber-400' :
                                'text-gray-400'
                              }`}>
                                {log.status === 'success' ? '✓ Success' :
                                 log.status === 'error' ? '✗ Error' :
                                 log.status === 'running' ? '⏳ Running' : log.status}
                              </span>
                              <span className="text-xs text-gray-500">
                                {new Date(log.timestamp).toLocaleString()}
                              </span>
                              {log.duration_ms != null && (
                                <span className="text-xs text-gray-500 font-mono">
                                  {(log.duration_ms / 1000).toFixed(1)}s
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => setExpandedLog(null)}
                              className="text-xs text-gray-500 hover:text-gray-300"
                            >
                              ✕
                            </button>
                          </div>
                          {log.result ? (
                            <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-40 overflow-y-auto">
                              {log.result}
                            </pre>
                          ) : (
                            <p className="text-xs text-gray-600 italic">No output yet</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                <button
                  onClick={() => triggerRun(cronJob.id)}
                  disabled={running[cronJob.id]}
                  className="text-xs bg-gray-700 hover:bg-gray-600 px-2.5 py-2 sm:py-1 rounded-md transition-colors disabled:opacity-50 min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                >
                  {running[cronJob.id] ? '⏳' : '▶'}
                </button>
                <button
                  onClick={() => toggleCron(cronJob)}
                  className={`text-xs px-2.5 py-2 sm:py-1 rounded-md transition-colors min-h-[36px] sm:min-h-0 flex items-center ${
                    cronJob.enabled
                      ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  {cronJob.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => deleteCron(cronJob.id)}
                  className="text-xs text-gray-500 hover:text-red-400 px-2 py-2 sm:px-1 sm:py-1 transition-colors min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
        {crons.length === 0 && (
          <p className="text-sm text-gray-500">No cron jobs configured</p>
        )}
      </div>
    </div>
  );
}

function SlackSection() {
  const [status, setStatus] = useState([]);
  const [messages, setMessages] = useState([]);
  const [restarting, setRestarting] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = async () => {
    try {
      const data = await api.getSlackStatus();
      setStatus(data);
    } catch (err) {
      console.error('Failed to load Slack status:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (agentId) => {
    try {
      const data = await api.getSlackMessages(agentId, 20);
      setMessages(data);
    } catch (err) {
      console.error('Failed to load Slack messages:', err);
    }
  };

  useEffect(() => {
    loadStatus();
    loadMessages();
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartSlack();
      await loadStatus();
    } catch (err) {
      console.error('Restart failed:', err);
    } finally {
      setRestarting(false);
    }
  };

  const handleSelectAgent = (agentId) => {
    if (selectedAgent === agentId) {
      setSelectedAgent(null);
      loadMessages();
    } else {
      setSelectedAgent(agentId);
      loadMessages(agentId);
    }
  };

  if (loading) {
    return <div className="text-gray-500 text-sm">Loading Slack status...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Slack Bots</h3>
        <button
          onClick={handleRestart}
          disabled={restarting}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {restarting ? '⏳ Restarting...' : '🔄 Restart All'}
        </button>
      </div>

      {status.length === 0 ? (
        <p className="text-sm text-gray-500">No Slack accounts configured</p>
      ) : (
        <div className="space-y-3">
          {status.map((bot) => (
            <div
              key={bot.name}
              className="bg-gray-800 rounded-xl p-4 cursor-pointer hover:bg-gray-750"
              onClick={() => handleSelectAgent(bot.agentId)}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`w-3 h-3 rounded-full flex-shrink-0 ${
                    bot.connected
                      ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                      : 'bg-red-400'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                    <span className="font-medium text-sm">{bot.name}</span>
                    <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded font-mono truncate max-w-[120px] sm:max-w-none">→ {bot.agentId}</span>
                  </div>
                  {bot.channels && (
                    <p className="text-xs text-gray-500 mt-0.5">Channels: {bot.channels.join(', ')}</p>
                  )}
                  {bot.error && (
                    <p className="text-xs text-red-400 mt-0.5">{bot.error}</p>
                  )}
                  {bot.lastMessage && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Last message: {relativeTime(bot.lastMessage)}
                    </p>
                  )}
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-md ${
                  bot.connected
                    ? 'bg-emerald-800/50 text-emerald-400'
                    : 'bg-red-900/50 text-red-400'
                }`}>
                  {bot.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent messages */}
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-gray-400 mb-3">
          Recent Messages{selectedAgent ? ` (${selectedAgent})` : ''}
        </h4>
        {messages.length === 0 ? (
          <p className="text-xs text-gray-500">No messages yet</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {messages.map((msg) => (
              <div key={msg.id} className="bg-gray-800 rounded-lg p-3 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-500 font-mono">{msg.agent_id}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-500">
                    {relativeTime(msg.timestamp)}
                  </span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-600 font-mono">{msg.channel_id}</span>
                </div>
                <p className="text-blue-300 mb-1">
                  <span className="text-gray-500">User:</span> {msg.user_message?.substring(0, 200)}
                  {msg.user_message?.length > 200 ? '...' : ''}
                </p>
                <p className="text-gray-300">
                  <span className="text-gray-500">Bot:</span>{' '}
                  {msg.bot_response?.substring(0, 300)}
                  {msg.bot_response?.length > 300 ? '...' : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentConfigSection({ agents: initialAgents, onAgentsChange }) {
  const [agents, setAgents] = useState(initialAgents);
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState({});
  const [saveStatus, setSaveStatus] = useState({});
  const [edits, setEdits] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [newForm, setNewForm] = useState({
    id: '',
    name: '',
    engine: 'claude-code',
    cwd: '/home/ryan',
    workspace: '',
    color: '#6b7280',
    systemPrompt: '',
    heartbeat: { enabled: false, interval: '', prompt: '' },
  });

  useEffect(() => {
    setAgents(initialAgents);
  }, [initialAgents]);

  const getEdit = (agentId) => {
    if (edits[agentId]) return edits[agentId];
    const agent = agents.find((a) => a.id === agentId);
    return agent ? { ...agent } : {};
  };

  const setEdit = (agentId, field, value) => {
    setEdits((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] || agents.find((a) => a.id === agentId)), [field]: value },
    }));
  };

  const setHeartbeatEdit = (agentId, field, value) => {
    const current = getEdit(agentId);
    const hb = { ...(current.heartbeat || { enabled: false, interval: '', prompt: '' }), [field]: value };
    setEdit(agentId, 'heartbeat', hb);
  };

  const handleSave = async (agentId) => {
    setSaving((prev) => ({ ...prev, [agentId]: true }));
    try {
      const data = edits[agentId];
      if (!data) return;
      const { id, lastActivity, lastMessage, ...payload } = data;
      const updated = await api.updateAgent(agentId, payload);
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...updated } : a)));
      setEdits((prev) => { const n = { ...prev }; delete n[agentId]; return n; });
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'saved' }));
      if (onAgentsChange) onAgentsChange();
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 2000);
    } catch (e) {
      setSaveStatus((prev) => ({ ...prev, [agentId]: 'error' }));
      setTimeout(() => setSaveStatus((prev) => ({ ...prev, [agentId]: null })), 3000);
    } finally {
      setSaving((prev) => ({ ...prev, [agentId]: false }));
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const created = await api.createAgent(newForm);
      setAgents((prev) => [...prev, created]);
      setShowNew(false);
      setNewForm({ id: '', name: '', engine: 'claude-code', cwd: '/home/ryan', workspace: '', color: '#6b7280', systemPrompt: '', heartbeat: { enabled: false, interval: '', prompt: '' } });
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to create agent:', e);
    }
  };

  const handleToggleActive = async (agentId, currentlyActive) => {
    try {
      const updated = await api.updateAgent(agentId, { active: !currentlyActive });
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, active: updated.active } : a)));
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to toggle agent active state:', e);
    }
  };

  const handleDelete = async (agentId) => {
    try {
      await api.deleteAgent(agentId);
      setAgents((prev) => prev.filter((a) => a.id !== agentId));
      setConfirmDelete(null);
      if (onAgentsChange) onAgentsChange();
    } catch (e) {
      console.error('Failed to delete agent:', e);
    }
  };

  const inputClass =
    'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-gray-600';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Agent Configurations</h3>
        <button
          onClick={() => setShowNew(!showNew)}
          className="text-xs bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          {showNew ? 'Cancel' : '+ New Agent'}
        </button>
      </div>

      {showNew && (
        <form onSubmit={handleCreate} className="bg-gray-800 rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>ID (required, alphanumeric + hyphens)</label>
              <input
                value={newForm.id}
                onChange={(e) => setNewForm({ ...newForm, id: e.target.value })}
                required
                pattern="[a-zA-Z0-9-]+"
                className={inputClass}
                placeholder="my-agent"
              />
            </div>
            <div>
              <label className={labelClass}>Name</label>
              <input
                value={newForm.name}
                onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
                className={inputClass}
                placeholder="My Agent"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Engine</label>
              <select
                value={newForm.engine}
                onChange={(e) => setNewForm({ ...newForm, engine: e.target.value })}
                className={inputClass}
              >
                <option value="claude-code">claude-code</option>
                <option value="cursor-agent">cursor-agent</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newForm.color}
                  onChange={(e) => setNewForm({ ...newForm, color: e.target.value })}
                  className="w-10 h-10 rounded border border-gray-700 cursor-pointer bg-transparent"
                />
                <span className="text-xs text-gray-400 font-mono">{newForm.color}</span>
              </div>
            </div>
          </div>
          <div>
            <label className={labelClass}>Working Directory</label>
            <input
              value={newForm.cwd}
              onChange={(e) => setNewForm({ ...newForm, cwd: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Workspace</label>
            <input
              value={newForm.workspace}
              onChange={(e) => setNewForm({ ...newForm, workspace: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>System Prompt</label>
            <textarea
              value={newForm.systemPrompt}
              onChange={(e) => setNewForm({ ...newForm, systemPrompt: e.target.value })}
              rows={3}
              className={inputClass + ' resize-none'}
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Create Agent
          </button>
        </form>
      )}

      <div className="space-y-3">
        {agents.map((agent) => {
          const isExpanded = expanded === agent.id;
          const edit = getEdit(agent.id);
          const isDirty = !!edits[agent.id];
          return (
            <div key={agent.id} className={`bg-gray-800 rounded-xl overflow-hidden${agent.active === false ? ' opacity-50' : ''}`}>
              <div
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-gray-750"
                onClick={() => setExpanded(isExpanded ? null : agent.id)}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: agent.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{agent.name}</span>
                    <span className="text-xs text-gray-500 font-mono">{agent.id}</span>
                    <span className="text-xs text-gray-500">{agent.engine}</span>
                    {agent.active === false && (
                      <span className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
                        inactive
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 font-mono mt-0.5 truncate">
                    {agent.cwd}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleActive(agent.id, agent.active !== false);
                    }}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      agent.active !== false
                        ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {agent.active !== false ? 'Active' : 'Inactive'}
                  </button>
                  {saveStatus[agent.id] === 'saved' && (
                    <span className="text-xs text-emerald-400">✓ Saved</span>
                  )}
                  {saveStatus[agent.id] === 'error' && (
                    <span className="text-xs text-red-400">✕ Error</span>
                  )}
                  <span className="text-xs text-gray-400">
                    {isExpanded ? '▲' : '▼'}
                  </span>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-gray-700 p-4 space-y-3">
                  <div>
                    <label className={labelClass}>ID</label>
                    <p className="text-sm text-gray-300 font-mono bg-gray-900 rounded-lg px-3 py-2">{agent.id}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Name</label>
                      <input
                        value={edit.name || ''}
                        onChange={(e) => setEdit(agent.id, 'name', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Engine</label>
                      <select
                        value={edit.engine || 'claude-code'}
                        onChange={(e) => setEdit(agent.id, 'engine', e.target.value)}
                        className={inputClass}
                      >
                        <option value="claude-code">claude-code</option>
                        <option value="cursor-agent">cursor-agent</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={edit.color || '#6b7280'}
                          onChange={(e) => setEdit(agent.id, 'color', e.target.value)}
                          className="w-10 h-10 rounded border border-gray-700 cursor-pointer bg-transparent"
                        />
                        <span className="text-xs text-gray-400 font-mono">{edit.color || agent.color}</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className={labelClass}>Working Directory (CWD)</label>
                    <input
                      value={edit.cwd || ''}
                      onChange={(e) => setEdit(agent.id, 'cwd', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Workspace</label>
                    <input
                      value={edit.workspace || ''}
                      onChange={(e) => setEdit(agent.id, 'workspace', e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>System Prompt</label>
                    <textarea
                      value={edit.systemPrompt || ''}
                      onChange={(e) => setEdit(agent.id, 'systemPrompt', e.target.value)}
                      rows={4}
                      className={inputClass + ' resize-none'}
                    />
                  </div>

                  {/* Heartbeat settings */}
                  <div className="border-t border-gray-700 pt-3">
                    <div className="flex items-center gap-3 mb-3">
                      <label className="text-xs text-gray-400 font-medium">Heartbeat</label>
                      <button
                        onClick={() =>
                          setHeartbeatEdit(agent.id, 'enabled', !(edit.heartbeat?.enabled))
                        }
                        className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                          edit.heartbeat?.enabled
                            ? 'bg-emerald-800/50 text-emerald-400 hover:bg-emerald-800'
                            : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                        }`}
                      >
                        {edit.heartbeat?.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className={labelClass}>Interval (cron expression)</label>
                        <input
                          value={edit.heartbeat?.interval || ''}
                          onChange={(e) => setHeartbeatEdit(agent.id, 'interval', e.target.value)}
                          placeholder="*/30 * * * *"
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Heartbeat Prompt</label>
                        <textarea
                          value={edit.heartbeat?.prompt || ''}
                          onChange={(e) => setHeartbeatEdit(agent.id, 'prompt', e.target.value)}
                          rows={3}
                          className={inputClass + ' resize-none'}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      onClick={() => {
                        if (confirmDelete === agent.id) {
                          handleDelete(agent.id);
                        } else {
                          setConfirmDelete(agent.id);
                          setTimeout(() => setConfirmDelete(null), 3000);
                        }
                      }}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        confirmDelete === agent.id
                          ? 'bg-red-600 text-white hover:bg-red-500'
                          : 'text-gray-500 hover:text-red-400 hover:bg-gray-700'
                      }`}
                    >
                      {confirmDelete === agent.id ? 'Confirm Delete' : 'Delete Agent'}
                    </button>
                    <button
                      onClick={() => handleSave(agent.id)}
                      disabled={!isDirty || saving[agent.id]}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      {saving[agent.id] ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {agents.length === 0 && (
          <p className="text-sm text-gray-500">No agents configured</p>
        )}
      </div>
    </div>
  );
}

function UsageSection() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getUsage()
      .then(setUsage)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading usage data...</p>;
  }

  if (!usage || !usage.totals) {
    return <p className="text-sm text-gray-500">No usage data available yet. Usage is tracked from Claude Code stream-json output.</p>;
  }

  const { totals, byAgent, byDay, recentSessions } = usage;
  const fmtCost = (c) => `$${Number(c || 0).toFixed(2)}`;
  const fmtDuration = (ms) => {
    const s = (ms || 0) / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };

  // Find max daily cost for bar chart scaling
  const maxDayCost = Math.max(...(byDay || []).map((d) => d.cost), 0.01);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Cost</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{fmtCost(totals.total_cost)}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Time</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">{fmtDuration(totals.total_duration_ms)}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Turns</p>
            <p className="text-2xl font-bold text-gray-200 mt-1">{totals.total_turns}</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Messages</p>
            <p className="text-2xl font-bold text-gray-200 mt-1">{totals.count}</p>
          </div>
        </div>
      </div>

      {/* Per-agent breakdown */}
      {byAgent?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">By Agent</h3>
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-left text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Time</th>
                  <th className="px-4 py-3 text-right">Turns</th>
                  <th className="px-4 py-3 text-right">Messages</th>
                </tr>
              </thead>
              <tbody>
                {byAgent.map((row) => (
                  <tr key={row.agent_id} className="border-b border-gray-700/50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.agent_color }} />
                        <span className="font-medium">{row.agent_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-400 font-mono">{fmtCost(row.total_cost)}</td>
                    <td className="px-4 py-3 text-right text-gray-400 font-mono">{fmtDuration(row.total_duration_ms)}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{row.total_turns}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily usage chart */}
      {byDay?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Daily Cost (last 30 days)</h3>
          <div className="bg-gray-800 rounded-xl p-4">
            <div className="space-y-1.5">
              {byDay.map((day) => {
                const pct = (day.cost / maxDayCost) * 100;
                return (
                  <div key={day.day} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 font-mono w-20 flex-shrink-0">
                      {day.day.slice(5)}
                    </span>
                    <div className="flex-1 h-5 bg-gray-900 rounded overflow-hidden">
                      <div
                        className="h-full bg-emerald-600/60 rounded"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400 font-mono w-16 text-right">
                      {fmtCost(day.cost)}
                    </span>
                    <span className="text-xs text-gray-600 w-8 text-right">{day.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Recent sessions */}
      {recentSessions?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3">Recent Sessions</h3>
          <div className="bg-gray-800 rounded-xl overflow-hidden">
            <div className="divide-y divide-gray-700/50">
              {recentSessions.map((s) => (
                <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.agent_color }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.session_name}</p>
                    <p className="text-xs text-gray-500">
                      {s.agent_name} · {s.message_count} message{s.message_count !== 1 ? 's' : ''}
                      {' · '}{fmtDuration(s.duration_ms)}
                    </p>
                  </div>
                  <span className="text-sm text-emerald-400 font-mono flex-shrink-0">{fmtCost(s.cost)}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Note: Only Claude Code sessions report cost. Cursor Agent sessions show duration only.
          </p>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage({ agents, onAgentsChange }) {
  const [tab, setTab] = useState('heartbeats');

  const tabs = [
    { id: 'heartbeats', label: '💓 Heartbeats' },
    { id: 'crons', label: '⏰ Cron Jobs' },
    { id: 'slack', label: '💬 Slack' },
    { id: 'agents', label: '🤖 Agents' },
    { id: 'usage', label: '📊 Usage' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold mb-6">Settings</h2>

        <div className="flex gap-1.5 sm:gap-2 mb-6 overflow-x-auto pb-1 -mx-1 px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 sm:px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] ${
                tab === t.id
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'heartbeats' && <HeartbeatSection />}
        {tab === 'crons' && <CronSection />}
        {tab === 'slack' && <SlackSection />}
        {tab === 'agents' && <AgentConfigSection agents={agents} onAgentsChange={onAgentsChange} />}
        {tab === 'usage' && <UsageSection />}
      </div>
    </div>
  );
}

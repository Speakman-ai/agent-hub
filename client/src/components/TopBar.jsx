import { useState, useRef, useEffect } from 'react';
import { formatSessionExport, copyToClipboard } from '../utils/export.js';
import { api } from '../utils/api.js';
import BugReportButton from './BugReportButton.jsx';

const ENGINE_OPTIONS = [{ id: 'claude-code', label: 'Claude Code', color: '#8B5CF6' }];

const ENGINE_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', short: 'Opus' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', short: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet', short: 'Sonnet' },
  ],
};

export default function TopBar({
  agent,
  connected,
  reconnecting,
  onNewSession,
  onNavigate,
  onToggleSidebar,
  sessionEngine,
  onEngineChange: _onEngineChange,
  sessionModel,
  onModelChange,
  messages,
  activeSessionId,
  sessionWorktree,
  gitWorktreeDetected,
  onWorktreeChange,
  sessionAskMode,
  onAskModeChange,
  verboseMode,
  onVerboseModeChange,
  projectId,
  showToast,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState(null); // null | 'summarizing' | 'copied'
  const modelRef = useRef(null);
  const exportRef = useRef(null);
  const currentEngine = ENGINE_OPTIONS.find((e) => e.id === sessionEngine) || ENGINE_OPTIONS[0];
  const engineModels = ENGINE_MODELS[sessionEngine] || ENGINE_MODELS['claude-code'];
  const currentModel = engineModels.find((m) => m.id === sessionModel) || engineModels[0];

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (modelRef.current && !modelRef.current.contains(e.target)) {
        setModelOpen(false);
      }
      if (exportRef.current && !exportRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="flex items-center justify-between px-3 md:px-6 py-2 md:py-3 border-b border-gray-800 bg-gray-900/50 electron-no-drag">
      <div className="flex items-center gap-3">
        {/* Mobile sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="md:hidden text-gray-400 hover:text-white p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
        <BugReportButton projectId={projectId} agentId={agent?.id} onToast={showToast} />
        {agent && (
          <>
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: agent.color }}
            />
            <div className="min-w-0">
              <h2 className="font-semibold truncate">{agent.name}</h2>
              <p className="text-xs text-gray-500 font-mono truncate hidden sm:block">
                {agent.cwd}
              </p>
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 md:gap-3">
        {/* Desktop: Worktree Toggle + Detection Badge */}
        {agent && (
          <div className="hidden sm:flex items-center gap-1">
            <button
              onClick={() => onWorktreeChange(!sessionWorktree)}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
                sessionWorktree
                  ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/50'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:bg-gray-700'
              }`}
              title={`Git worktree isolation: ${sessionWorktree ? 'ON — each session uses its own branch' : 'OFF — working directly in the project directory'}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-3.5 w-3.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a7 7 0 017 7v2a1 1 0 11-2 0v-2a5 5 0 00-5-5H5.414l2.293 2.293a1 1 0 11-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{sessionWorktree ? 'Isolated' : 'Shared'}</span>
            </button>
            {gitWorktreeDetected != null && (
              <span
                className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  gitWorktreeDetected
                    ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/40'
                    : sessionWorktree
                      ? 'bg-amber-900/40 text-amber-400 border border-amber-700/40'
                      : 'bg-gray-800 text-gray-500 border border-gray-700'
                }`}
                title={
                  gitWorktreeDetected
                    ? 'CLI confirmed: running inside a git worktree'
                    : sessionWorktree
                      ? 'Warning: worktree mode is ON but CLI is not in a git worktree'
                      : 'CLI confirmed: not in a git worktree'
                }
              >
                {gitWorktreeDetected ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-2.5 w-2.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : sessionWorktree ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-2.5 w-2.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-2.5 w-2.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                <span>{gitWorktreeDetected ? 'WT' : sessionWorktree ? '!' : '—'}</span>
              </span>
            )}
          </div>
        )}

        {/* Desktop: Ask Mode Toggle */}
        {agent && (
          <button
            onClick={() => onAskModeChange(!sessionAskMode)}
            className={`hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
              sessionAskMode
                ? 'bg-blue-900/30 border-blue-700/50 text-blue-400 hover:bg-blue-900/50'
                : 'bg-gray-800 border-gray-700 text-gray-500 hover:bg-gray-700'
            }`}
            title={`Ask mode: ${sessionAskMode ? 'ON — read-only, no file changes or commands' : 'OFF — agent can make changes'}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <span>{sessionAskMode ? 'Ask' : 'Agent'}</span>
          </button>
        )}

        {/* Desktop: Verbose Mode Toggle */}
        {agent && (
          <button
            onClick={() => onVerboseModeChange(!verboseMode)}
            className={`hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg transition-colors border ${
              verboseMode
                ? 'bg-orange-900/30 border-orange-700/50 text-orange-400 hover:bg-orange-900/50'
                : 'bg-gray-800 border-gray-700 text-gray-500 hover:bg-gray-700'
            }`}
            title={`Verbose mode: ${verboseMode ? 'ON — tool calls and thinking auto-expand' : 'OFF — tool calls collapsed by default'}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span>{verboseMode ? 'Verbose' : 'Compact'}</span>
          </button>
        )}

        {/* Desktop: Model Selector */}
        {agent && (
          <div className="hidden sm:flex items-center gap-1.5" ref={modelRef}>
            <div className="relative">
              <button
                onClick={() => setModelOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors border border-gray-700"
                title={`Model: ${currentModel.label}`}
              >
                <span className="text-gray-300">{currentModel.short}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3 w-3 text-gray-500 transition-transform ${modelOpen ? 'rotate-180' : ''}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M5.293 7.293a1 1 0 011.414 0L10 11.586l4.293-4.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              {modelOpen && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[180px] py-1">
                  {engineModels.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        onModelChange(m.id);
                        setModelOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        m.id === sessionModel ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span>{m.label}</span>
                      {m.id === sessionModel && <span className="text-emerald-400 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mobile: combined engine+model button */}
        {agent && (
          <div className="sm:hidden relative">
            <button
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors border border-gray-700"
            >
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: currentEngine.color }}
              />
              <span className="text-gray-300">{currentModel.short}</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-3 w-3 text-gray-500 transition-transform ${mobileMenuOpen ? 'rotate-180' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M5.293 7.293a1 1 0 011.414 0L10 11.586l4.293-4.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {mobileMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] py-1">
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">
                    Model
                  </div>
                  {engineModels.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        onModelChange(m.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        m.id === sessionModel ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span>{m.label}</span>
                      {m.id === sessionModel && <span className="text-emerald-400 text-xs">✓</span>}
                    </button>
                  ))}
                  <div className="border-t border-gray-700 my-1" />
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">
                    Worktree
                  </div>
                  <button
                    onClick={() => {
                      onWorktreeChange(!sessionWorktree);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                      sessionWorktree ? 'text-emerald-400' : 'text-gray-400'
                    }`}
                  >
                    <span>
                      {sessionWorktree ? 'Isolated (own branch)' : 'Shared (project dir)'}
                    </span>
                    {sessionWorktree && <span className="text-emerald-400 text-xs">✓</span>}
                  </button>
                  {gitWorktreeDetected != null && (
                    <div
                      className={`mx-3 mb-1 px-2 py-1 rounded text-xs ${
                        gitWorktreeDetected
                          ? 'bg-emerald-900/30 text-emerald-400'
                          : sessionWorktree
                            ? 'bg-amber-900/30 text-amber-400'
                            : 'bg-gray-800 text-gray-500'
                      }`}
                    >
                      {gitWorktreeDetected
                        ? '✓ CLI confirmed worktree'
                        : sessionWorktree
                          ? '⚠ CLI not in worktree'
                          : '— CLI not in worktree'}
                    </div>
                  )}
                  <div className="border-t border-gray-700 my-1" />
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">
                    Mode
                  </div>
                  <button
                    onClick={() => {
                      onAskModeChange(!sessionAskMode);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                      sessionAskMode ? 'text-blue-400' : 'text-gray-400'
                    }`}
                  >
                    <span>{sessionAskMode ? 'Ask (read-only)' : 'Agent (full access)'}</span>
                    {sessionAskMode && <span className="text-blue-400 text-xs">✓</span>}
                  </button>
                  <div className="border-t border-gray-700 my-1" />
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">
                    Output
                  </div>
                  <button
                    onClick={() => {
                      onVerboseModeChange(!verboseMode);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                      verboseMode ? 'text-orange-400' : 'text-gray-400'
                    }`}
                  >
                    <span>{verboseMode ? 'Verbose (expanded)' : 'Compact (collapsed)'}</span>
                    {verboseMode && <span className="text-orange-400 text-xs">✓</span>}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Connection status - icon only on mobile */}
        <span
          className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${
            connected
              ? 'bg-emerald-900/50 text-emerald-400'
              : reconnecting
                ? 'bg-yellow-900/50 text-yellow-400'
                : 'bg-red-900/50 text-red-400'
          }`}
          title={connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}
        >
          <span className="sm:hidden">●</span>
          <span className="hidden sm:inline">
            {connected ? '● Connected' : reconnecting ? '● Reconnecting...' : '● Disconnected'}
          </span>
        </span>
        {/* Export conversation dropdown */}
        {agent && messages?.length > 0 && (
          <div className="relative" ref={exportRef}>
            <button
              onClick={() => setExportOpen((v) => !v)}
              className="text-gray-400 hover:text-white p-2 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
              title="Export conversation"
            >
              {exportState === 'copied' ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5 text-emerald-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : exportState === 'summarizing' ? (
                <svg
                  className="h-5 w-5 animate-spin text-blue-400"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                  <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                </svg>
              )}
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[180px] py-1">
                <button
                  onClick={async () => {
                    const text = formatSessionExport({ agent, messages, sessionEngine });
                    const ok = await copyToClipboard(text);
                    if (ok) {
                      setExportState('copied');
                      setTimeout(() => setExportState(null), 2000);
                    }
                    setExportOpen(false);
                  }}
                  className="w-full text-left px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors flex items-center gap-2"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4 text-gray-500"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                    <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                  </svg>
                  Copy Raw
                </button>
                <button
                  onClick={async () => {
                    setExportOpen(false);
                    setExportState('summarizing');
                    try {
                      const { summary } = await api.summarizeSession(activeSessionId);
                      const ok = await copyToClipboard(summary);
                      setExportState(ok ? 'copied' : null);
                      if (ok) setTimeout(() => setExportState(null), 2000);
                    } catch (err) {
                      console.error('Summarize failed:', err);
                      setExportState(null);
                      alert('Summary failed: ' + err.message);
                    }
                  }}
                  disabled={exportState === 'summarizing'}
                  className="w-full text-left px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4 text-gray-500"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Copy Summary
                </button>
              </div>
            )}
          </div>
        )}
        <button
          onClick={onNewSession}
          disabled={!agent}
          className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 hidden sm:block"
        >
          + New
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className="text-gray-400 hover:text-white p-2 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
          title="Settings"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

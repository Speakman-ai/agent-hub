import { useState, useRef, useEffect } from 'react';
import {
  formatSessionExport,
  copyToClipboard,
  buildNoteTitle,
  saveConversationAsNote,
} from '../utils/export.js';
import { api } from '../utils/api.js';
import BugReportButton from './BugReportButton.jsx';

const ENGINE_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', color: '#8B5CF6' },
  { id: 'cursor-agent', label: 'Cursor Agent', color: '#10B981' },
  // OpenAI Codex CLI — green brand color (#10A37F) per openai.com. See
  // server/routes/codex-auth.ts + server/config.ts for the auth + model contract.
  { id: 'codex-cli', label: 'Codex', color: '#10A37F' },
];

const MODEL_LABELS = {
  'claude-opus-4-8': { label: 'Opus 4.8', short: 'Opus' },
  'claude-opus-4-7': { label: 'Opus 4.7', short: 'Opus 4.7' },
  'claude-opus-4-6': { label: 'Opus 4.6', short: 'Opus 4.6' },
  'claude-sonnet-4-6': { label: 'Sonnet', short: 'Sonnet' },
  'composer-2.5': { label: 'Composer 2.5', short: 'Composer 2.5' },
  'gpt-5.3-codex': { label: 'GPT-5.3 Codex', short: '5.3 Codex' },
  'gpt-5.5': { label: 'GPT-5.5', short: '5.5' },
  'gpt-5.4': { label: 'GPT-5.4', short: '5.4' },
  'gpt-5.4-mini': { label: 'GPT-5.4 Mini', short: '5.4 Mini' },
  'gpt-5.2': { label: 'GPT-5.2', short: '5.2' },
};

function modelDisplay(id) {
  if (MODEL_LABELS[id]) return { id, ...MODEL_LABELS[id] };
  const label = String(id || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, label: label || 'Unknown model', short: label || 'Unknown' };
}

function fallbackModelsForEngine(engine) {
  if (engine === 'cursor-agent') return ['composer-2.5'];
  if (engine === 'codex-cli')
    return ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];
  return ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'];
}

export default function TopBar({
  agent,
  accentColor,
  connected,
  reconnecting,
  onNewSession,
  onNavigate,
  onToggleSidebar,
  sessionEngine,
  onEngineChange,
  sessionModel,
  onModelChange,
  modelConfig,
  messages,
  activeSessionId,
  sessionAskMode,
  onAskModeChange,
  projectId,
  showToast,
  onOpenForward,
  canForward,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState(null); // null | 'summarizing' | 'copied' | 'saving' | 'saved'
  const modelRef = useRef(null);
  const engineRef = useRef(null);
  const exportRef = useRef(null);
  const filteredEngineOptions = modelConfig?.engineValidModels
    ? ENGINE_OPTIONS.filter((e) => (modelConfig.engineValidModels[e.id]?.length ?? 0) > 0)
    : ENGINE_OPTIONS;
  const engineOptions = filteredEngineOptions.length > 0 ? filteredEngineOptions : ENGINE_OPTIONS;
  const currentEngine = engineOptions.find((e) => e.id === sessionEngine) || engineOptions[0];
  const engineModelIds = modelConfig?.engineValidModels
    ? modelConfig.engineValidModels[sessionEngine] || []
    : fallbackModelsForEngine(sessionEngine);
  const engineModels = engineModelIds.map((id) => modelDisplay(id));
  const currentModel =
    engineModels.find((m) => m.id === sessionModel) ||
    engineModels[0] ||
    modelDisplay(sessionModel || 'unknown-model');

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (modelRef.current && !modelRef.current.contains(e.target)) {
        setModelOpen(false);
      }
      if (engineRef.current && !engineRef.current.contains(e.target)) {
        setEngineOpen(false);
      }
      if (exportRef.current && !exportRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const headerAccent = accentColor || agent?.color || '#6366f1';

  return (
    <div
      className="flex items-center justify-between px-3 md:px-6 py-2 md:py-3 border-b-2 border-gray-800 bg-gray-900/50 electron-no-drag"
      style={{ borderBottomColor: headerAccent }}
    >
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
              style={{ backgroundColor: headerAccent }}
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

        {/* Desktop: Engine Selector */}
        {agent && (
          <div className="hidden sm:flex items-center gap-1.5" ref={engineRef}>
            <div className="relative">
              <button
                onClick={() => setEngineOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors border border-gray-700"
                title={`Engine: ${currentEngine.label}`}
                aria-label="Select engine"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: currentEngine.color }}
                />
                <span className="text-gray-300">{currentEngine.label}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3 w-3 text-gray-500 transition-transform ${engineOpen ? 'rotate-180' : ''}`}
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
              {engineOpen && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[180px] py-1">
                  {engineOptions.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        onEngineChange(e.id);
                        setEngineOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        e.id === sessionEngine ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: e.color }}
                        />
                        {e.label}
                      </span>
                      {e.id === sessionEngine && (
                        <span className="text-emerald-400 text-xs">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
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
                    Engine
                  </div>
                  {engineOptions.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => {
                        onEngineChange(e.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        e.id === sessionEngine ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: e.color }}
                        />
                        {e.label}
                      </span>
                      {e.id === sessionEngine && (
                        <span className="text-emerald-400 text-xs">✓</span>
                      )}
                    </button>
                  ))}
                  <div className="border-t border-gray-700 my-1" />
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
              {exportState === 'copied' || exportState === 'saved' ? (
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
              ) : exportState === 'summarizing' || exportState === 'saving' ? (
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
                {projectId && (
                  <>
                    <div className="my-1 border-t border-gray-700" />
                    <button
                      onClick={async () => {
                        setExportOpen(false);
                        setExportState('saving');
                        const content = formatSessionExport({
                          agent,
                          messages,
                          sessionEngine,
                        });
                        const title = buildNoteTitle({ kind: 'raw', agent });
                        const { ok, note, error } = await saveConversationAsNote({
                          api,
                          projectId,
                          title,
                          content,
                        });
                        if (ok) {
                          setExportState('saved');
                          setTimeout(() => setExportState(null), 2000);
                          showToast?.(`Saved note "${note.title}"`, 'success');
                        } else {
                          setExportState(null);
                          showToast?.(
                            `Save note failed: ${error?.message || 'Unknown error'}`,
                            'error',
                          );
                        }
                      }}
                      disabled={exportState === 'saving' || exportState === 'summarizing'}
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
                          d="M3 4a2 2 0 012-2h6.586A2 2 0 0113 2.586L16.414 6A2 2 0 0117 7.414V16a2 2 0 01-2 2H5a2 2 0 01-2-2V4zm7 10a1 1 0 11-2 0v-2H6a1 1 0 110-2h2V8a1 1 0 112 0v2h2a1 1 0 110 2h-2v2z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Save Raw as Note
                    </button>
                    <button
                      onClick={async () => {
                        setExportOpen(false);
                        setExportState('summarizing');
                        try {
                          const { summary } = await api.summarizeSession(activeSessionId);
                          setExportState('saving');
                          const title = buildNoteTitle({ kind: 'summary', agent });
                          const { ok, note, error } = await saveConversationAsNote({
                            api,
                            projectId,
                            title,
                            content: summary,
                          });
                          if (ok) {
                            setExportState('saved');
                            setTimeout(() => setExportState(null), 2000);
                            showToast?.(`Saved note "${note.title}"`, 'success');
                          } else {
                            setExportState(null);
                            showToast?.(
                              `Save note failed: ${error?.message || 'Unknown error'}`,
                              'error',
                            );
                          }
                        } catch (err) {
                          console.error('Save summary as note failed:', err);
                          setExportState(null);
                          showToast?.(`Summary failed: ${err.message}`, 'error');
                        }
                      }}
                      disabled={exportState === 'summarizing' || exportState === 'saving'}
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
                          d="M3 4a2 2 0 012-2h6.586A2 2 0 0113 2.586L16.414 6A2 2 0 0117 7.414V16a2 2 0 01-2 2H5a2 2 0 01-2-2V4zm3 5a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h4a1 1 0 100-2H7z"
                          clipRule="evenodd"
                        />
                      </svg>
                      Save Summary as Note
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {/* Forward session to another agent */}
        {agent && activeSessionId && (
          <button
            onClick={onOpenForward}
            disabled={!canForward}
            title={
              canForward
                ? 'Forward this session to another agent (or fork into a new session on this agent)'
                : 'No agents in this project to forward to'
            }
            className="text-gray-400 hover:text-white p-2 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Forward session to another agent"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 10h11a4 4 0 014 4v3m0 0l-3-3m3 3l-3 3"
              />
            </svg>
          </button>
        )}
        {/* Reviewer agents are webhook-spawned only — hide the "+ New"
            affordance so users don't try to start a thread the server
            will refuse to create. */}
        {agent?.role !== 'reviewer' && (
          <button
            onClick={onNewSession}
            disabled={!agent}
            className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 hidden sm:block"
          >
            + New
          </button>
        )}
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

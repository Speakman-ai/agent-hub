import React, { useState, useRef, useEffect } from 'react';
import { formatSessionExport, copyToClipboard } from '../utils/export.js';
import { api } from '../utils/api.js';

const ENGINE_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', emoji: '🟣', color: '#8B5CF6' },
  { id: 'cursor-agent', label: 'Cursor Agent', emoji: '🟢', color: '#10B981' },
];

const ENGINE_MODELS = {
  'claude-code': [
    { id: 'claude-opus-4-6', label: 'Opus', short: 'Opus' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet', short: 'Sonnet' },
  ],
  'cursor-agent': [
    { id: 'gpt-5.3-codex-high', label: 'Codex 5.3 High', short: 'C5.3-H' },
    { id: 'gpt-5.3-codex', label: 'Codex 5.3', short: 'C5.3' },
    { id: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low', short: 'C5.3-L' },
    { id: 'gpt-5.3-codex-fast', label: 'Codex 5.3 Fast', short: 'C5.3-F' },
    { id: 'gpt-5.2-codex-high', label: 'Codex 5.2 High', short: 'C5.2-H' },
    { id: 'gpt-5.2-codex', label: 'Codex 5.2', short: 'C5.2' },
    { id: 'gpt-5.1-codex-max-high', label: 'Codex 5.1 Max High', short: 'C5.1MH' },
    { id: 'composer-2', label: 'Composer 2', short: 'Comp2' },
    { id: 'composer-2-fast', label: 'Composer 2 Fast', short: 'Comp2F' },
    { id: 'auto', label: 'Auto', short: 'Auto' },
  ],
};

const ALL_MODELS = Object.values(ENGINE_MODELS).flat();

export default function TopBar({
  agent,
  connected,
  reconnecting,
  onNewSession,
  onNavigate,
  onToggleSidebar,
  sessionEngine,
  onEngineChange,
  sessionModel,
  onModelChange,
  messages,
  activeSessionId,
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
    <div className="flex items-center justify-between px-3 md:px-6 py-2 md:py-3 border-b border-gray-800 bg-gray-900/50">
      <div className="flex items-center gap-3">
        {/* Mobile sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="md:hidden text-gray-400 hover:text-white p-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
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
        {/* Desktop: Engine Toggle */}
        {agent && (
          <button
            onClick={() => {
              const next = sessionEngine === 'claude-code' ? 'cursor-agent' : 'claude-code';
              onEngineChange(next);
            }}
            className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors border border-gray-700"
            title={`Engine: ${currentEngine.label} (click to toggle)`}
          >
            <span>{currentEngine.emoji}</span>
            <span className="text-gray-300">{currentEngine.label}</span>
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
                <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 text-gray-500 transition-transform ${modelOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 11.586l4.293-4.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414z" clipRule="evenodd" />
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
                      {m.id === sessionModel && (
                        <span className="text-emerald-400 text-xs">✓</span>
                      )}
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
              <span>{currentEngine.emoji}</span>
              <span className="text-gray-300">{currentModel.short}</span>
              <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 text-gray-500 transition-transform ${mobileMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 11.586l4.293-4.293a1 1 0 111.414 1.414l-5 5a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
            {mobileMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] py-1">
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">Engine</div>
                  {ENGINE_OPTIONS.map((eng) => (
                    <button
                      key={eng.id}
                      onClick={() => {
                        onEngineChange(eng.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        eng.id === sessionEngine ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span className="flex items-center gap-2">{eng.emoji} {eng.label}</span>
                      {eng.id === sessionEngine && <span className="text-emerald-400 text-xs">✓</span>}
                    </button>
                  ))}
                  <div className="border-t border-gray-700 my-1" />
                  <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">Model</div>
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
          <span className="hidden sm:inline">{connected ? '● Connected' : reconnecting ? '● Reconnecting...' : '● Disconnected'}</span>
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
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : exportState === 'summarizing' ? (
                <svg className="h-5 w-5 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
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
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
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
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
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
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
}

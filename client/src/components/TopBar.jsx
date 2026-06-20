import { useState, useRef, useEffect } from 'react';
import {
  formatSessionExport,
  copyToClipboard,
  buildNoteTitle,
  saveConversationAsNote,
} from '../utils/export.js';
import { Palette } from 'lucide-react';
import { api } from '../utils/api.js';
import SessionStateIcon from './SessionStateIcon.jsx';

function truncateSessionId(id, tailLen = 8) {
  if (!id || id.length <= tailLen) return id;
  return `…${id.slice(-tailLen)}`;
}

const ENGINE_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', color: '#8B5CF6' },
  { id: 'cursor-agent', label: 'Cursor Agent', color: '#10B981' },
  // OpenAI Codex CLI — green brand color (#10A37F) per openai.com. See
  // server/routes/codex-auth.ts + server/config.ts for the auth + model contract.
  { id: 'codex-cli', label: 'Codex', color: '#10A37F' },
  // xAI Grok Build CLI — host-key authed (XAI_API_KEY) like Gemini. See
  // server/engine-availability.ts + the grok branches in server/chat.ts.
  { id: 'grok-cli', label: 'Grok', color: '#1D9BF0' },
];

const MODEL_LABELS = {
  'claude-fable-5': { label: 'Fable 5', short: 'Fable' },
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
  'grok-build': { label: 'Grok Build', short: 'Build' },
  'grok-composer-2.5-fast': { label: 'Composer 2.5 Fast', short: 'Composer' },
  'grok-build-0.1': { label: 'Grok Build', short: 'Build' },
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
  if (engine === 'codex-cli') return ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];
  if (engine === 'grok-cli') return ['grok-composer-2.5-fast', 'grok-build'];
  return [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ];
}

export default function TopBar({
  agent,
  accentColor,
  onNewSession,
  onToggleSidebar,
  sessionEngine,
  onEngineChange,
  sessionModel,
  onModelChange,
  sessionReasoningEffort,
  onReasoningEffortChange,
  modelConfig,
  messages,
  activeSessionId,
  activeSessionState,
  projectId,
  showToast,
  onOpenForward,
  canForward,
  onOpenLinkDesign,
  canLinkDesign,
  linkedDesignActive,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState(null); // null | 'summarizing' | 'copied' | 'saving' | 'saved'
  const modelRef = useRef(null);
  const engineRef = useRef(null);
  const reasoningRef = useRef(null);
  const exportRef = useRef(null);
  // Codex "thinking" level control. High (default) → model_reasoning_effort=high;
  // Pro → xhigh. Only shown for the codex-cli engine.
  const isCodex = sessionEngine === 'codex-cli';
  const reasoningPreset = sessionReasoningEffort === 'pro' ? 'pro' : 'high';
  const REASONING_OPTIONS = [
    { id: 'high', label: 'High', desc: 'Default reasoning effort' },
    { id: 'pro', label: 'Pro', desc: 'Maximum reasoning (xhigh)' },
  ];
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
  const copyActiveSessionId = async () => {
    if (!activeSessionId) return;
    const ok = await copyToClipboard(activeSessionId);
    showToast?.(
      ok ? `Copied session id ${activeSessionId}` : 'Could not copy session id',
      ok ? 'success' : 'error',
    );
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (modelRef.current && !modelRef.current.contains(e.target)) {
        setModelOpen(false);
      }
      if (engineRef.current && !engineRef.current.contains(e.target)) {
        setEngineOpen(false);
      }
      if (reasoningRef.current && !reasoningRef.current.contains(e.target)) {
        setReasoningOpen(false);
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
        {agent && (
          <>
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: headerAccent }}
            />
            {activeSessionId && (
              <SessionStateIcon
                state={activeSessionState}
                size={14}
                testId="topbar-session-state-icon"
              />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="font-semibold truncate">{agent.name}</h2>
                {activeSessionId && (
                  <button
                    type="button"
                    onClick={copyActiveSessionId}
                    className="hidden sm:inline-flex flex-shrink min-w-0 max-w-[7rem] items-center rounded-md border border-gray-700 bg-gray-800 px-2 py-0.5 font-mono text-[11px] text-gray-300 hover:border-gray-600 hover:bg-gray-700 hover:text-white sm:max-w-[18rem]"
                    title={`Copy session id: ${activeSessionId}`}
                    aria-label={`Copy session id ${activeSessionId}`}
                    data-testid="topbar-session-id"
                  >
                    <span className="mr-1 text-gray-500">Session</span>
                    <span className="truncate">{truncateSessionId(activeSessionId)}</span>
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 font-mono truncate hidden sm:block">
                {agent.cwd}
              </p>
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 md:gap-3">
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

        {/* Desktop: Codex reasoning ("thinking") level — High (default) / Pro (xhigh) */}
        {agent && isCodex && onReasoningEffortChange && (
          <div className="hidden sm:flex items-center gap-1.5" ref={reasoningRef}>
            <div className="relative">
              <button
                onClick={() => setReasoningOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors border border-gray-700"
                title={`Reasoning effort: ${reasoningPreset === 'pro' ? 'Pro (xhigh)' : 'High'}`}
                aria-label="Select reasoning effort"
              >
                <span className="text-gray-500">Think</span>
                <span className="text-gray-300">{reasoningPreset === 'pro' ? 'Pro' : 'High'}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3 w-3 text-gray-500 transition-transform ${reasoningOpen ? 'rotate-180' : ''}`}
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
              {reasoningOpen && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] py-1">
                  {REASONING_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => {
                        onReasoningEffortChange(o.id);
                        setReasoningOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                        o.id === reasoningPreset ? 'text-white' : 'text-gray-400'
                      }`}
                    >
                      <span className="flex flex-col">
                        <span>{o.label}</span>
                        <span className="text-[11px] text-gray-500">{o.desc}</span>
                      </span>
                      {o.id === reasoningPreset && (
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
                  {isCodex && onReasoningEffortChange && (
                    <>
                      <div className="border-t border-gray-700 my-1" />
                      <div className="px-3 py-1.5 text-xs text-gray-500 font-semibold uppercase">
                        Reasoning
                      </div>
                      {REASONING_OPTIONS.map((o) => (
                        <button
                          key={o.id}
                          onClick={() => {
                            onReasoningEffortChange(o.id);
                            setMobileMenuOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors flex items-center justify-between min-h-[44px] ${
                            o.id === reasoningPreset ? 'text-white' : 'text-gray-400'
                          }`}
                        >
                          <span className="flex flex-col">
                            <span>{o.label}</span>
                            <span className="text-[11px] text-gray-500">{o.desc}</span>
                          </span>
                          {o.id === reasoningPreset && (
                            <span className="text-emerald-400 text-xs">✓</span>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

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
                    <div className="my-1 border-t border-gray-700" />
                    <button
                      onClick={async () => {
                        setExportOpen(false);
                        setExportState('extracting');
                        try {
                          await api.extractSkillFromSession(activeSessionId);
                          setExportState(null);
                          showToast?.(
                            'Skill Builder is drafting a skill from this session — open the new "[Skill from] …" session to review it.',
                            'success',
                          );
                        } catch (err) {
                          console.error('Extract skill failed:', err);
                          setExportState(null);
                          showToast?.(
                            `Turn into Skill failed: ${err.message || 'Unknown error'}`,
                            'error',
                          );
                        }
                      }}
                      disabled={
                        exportState === 'extracting' ||
                        exportState === 'summarizing' ||
                        exportState === 'saving'
                      }
                      className="w-full text-left px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4 text-gray-500"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path d="M11 3a1 1 0 10-2 0v1a1 1 0 102 0V3zM15.657 5.757a1 1 0 00-1.414-1.414l-.707.707a1 1 0 001.414 1.414l.707-.707zM18 10a1 1 0 01-1 1h-1a1 1 0 110-2h1a1 1 0 011 1zM5.05 6.464A1 1 0 106.464 5.05l-.707-.707a1 1 0 00-1.414 1.414l.707.707zM5 10a1 1 0 01-1 1H3a1 1 0 110-2h1a1 1 0 011 1zM8 16v-1h4v1a2 2 0 11-4 0zM12 14c.015-.34.208-.646.477-.859a4 4 0 10-4.954 0c.27.213.462.519.476.859h4.002z" />
                      </svg>
                      {exportState === 'extracting' ? 'Starting…' : 'Turn into Skill'}
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
        {/* Link a Design Studio design — renders its live canvas beside the chat */}
        {agent && activeSessionId && (
          <button
            onClick={onOpenLinkDesign}
            disabled={!canLinkDesign}
            title={
              linkedDesignActive
                ? 'A design is linked — view, swap, or unlink it'
                : 'Link a design to preview its live mockup beside this chat'
            }
            className={`hidden sm:flex p-2 transition-colors min-w-[44px] min-h-[44px] items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed ${
              linkedDesignActive
                ? 'text-purple-400 hover:text-purple-300'
                : 'text-gray-400 hover:text-white'
            }`}
            aria-label="Link a design to this session"
            data-testid="topbar-link-design"
          >
            <Palette className="h-5 w-5" />
          </button>
        )}
        {/* New-session affordance for the active chat header. Mobile users
            start a new session from the persistent sidebar (opened via the
            hamburger), so this is desktop-only to keep the mobile header lean.
            Reviewer agents are spawned only by the Finalize review phase, so
            hide "+ New" for them — the server refuses to create the thread. */}
        {agent?.role !== 'reviewer' && (
          <button
            onClick={onNewSession}
            disabled={!agent || !onNewSession}
            className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 hidden sm:block"
          >
            + New
          </button>
        )}
      </div>
    </div>
  );
}

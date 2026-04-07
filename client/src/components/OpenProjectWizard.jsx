import React, { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = '/api';

const COLOR_PRESETS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
  '#F59E0B', '#10B981', '#06B6D4', '#6B7280',
];

const CONTEXT_FILE_TABS = ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];

const STEP_LABELS = ['Select Folder', 'Analyze', 'Review & Create'];

function deriveNameFromPath(path) {
  return path.split('/').filter(Boolean).pop() || '';
}

function deriveIdFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function Spinner({ size = 5 }) {
  return (
    <svg
      className={`animate-spin h-${size} w-${size} text-emerald-400`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function StepIndicator({ currentStep }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-6">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div className={`w-8 h-px ${isCompleted || isActive ? 'bg-emerald-500' : 'bg-gray-600'}`} />
            )}
            <div className="flex items-center gap-1.5">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-colors ${
                  isCompleted
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : isActive
                    ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10'
                    : 'border-gray-600 text-gray-500 bg-transparent'
                }`}
              >
                {isCompleted ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  stepNum
                )}
              </div>
              <span
                className={`text-xs font-medium ${
                  isActive ? 'text-emerald-400' : isCompleted ? 'text-emerald-500' : 'text-gray-500'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OpenProjectWizard({ onClose, onProjectCreated }) {
  const [step, setStep] = useState(1);

  // Step 1 state
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [color, setColor] = useState(COLOR_PRESETS[0]);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);

  // Step 2 state
  const [analyzing, setAnalyzing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);

  // Step 3 state
  const [selectedAgents, setSelectedAgents] = useState({});
  const [contextFiles, setContextFiles] = useState({});
  const [activeTab, setActiveTab] = useState('SOUL.md');
  const [creating, setCreating] = useState(false);

  const analyzeIdRef = useRef(null);
  const terminalRef = useRef(null);

  // Auto-derive name and id from path
  useEffect(() => {
    if (!nameManuallyEdited) {
      const derived = deriveNameFromPath(path);
      setName(derived);
      if (!idManuallyEdited) {
        setProjectId(deriveIdFromName(derived));
      }
    }
  }, [path, nameManuallyEdited, idManuallyEdited]);

  // Auto-derive id from name
  useEffect(() => {
    if (!idManuallyEdited) {
      setProjectId(deriveIdFromName(name));
    }
  }, [name, idManuallyEdited]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [progressText]);

  // Escape key closes modal
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // WebSocket events for analysis
  useEffect(() => {
    const handler = (e) => {
      const data = e.detail;
      if (data.analyzeId !== analyzeIdRef.current) return;
      if (data.type === 'analyze-progress') {
        setProgressText((prev) => prev + (data.chunk || data.text || ''));
      }
      if (data.type === 'analyze-complete') {
        setAnalyzing(false);
        setAnalysisResult(data.result);
        // Initialize step 3 state from result
        if (data.result?.agents) {
          const agentMap = {};
          data.result.agents.forEach((a, i) => { agentMap[i] = true; });
          setSelectedAgents(agentMap);
        }
        if (data.result?.contextFiles) {
          setContextFiles({ ...data.result.contextFiles });
        }
      }
      if (data.type === 'analyze-error') {
        setAnalyzing(false);
        setAnalysisError(data.error || 'Analysis failed.');
      }
    };
    window.addEventListener('analyze-ws', handler);
    return () => window.removeEventListener('analyze-ws', handler);
  }, []);

  const handleAnalyze = useCallback(async () => {
    setStep(2);
    setAnalyzing(true);
    setProgressText('');
    setAnalysisResult(null);
    setAnalysisError(null);

    try {
      const res = await fetch(`${API_BASE}/projects/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Analysis request failed: ${res.status}`);
      }
      const { analyzeId } = await res.json();
      analyzeIdRef.current = analyzeId;
    } catch (err) {
      setAnalyzing(false);
      setAnalysisError(err.message);
    }
  }, [path]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const agents = (analysisResult?.agents || []).filter((_, i) => selectedAgents[i]);
      const res = await fetch(`${API_BASE}/projects/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: { id: projectId, name, cwd: path, color },
          agents,
          contextFiles,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Create failed: ${res.status}`);
      }
      const project = await res.json();
      onProjectCreated(project);
      onClose();
    } catch (err) {
      setAnalysisError(err.message);
    } finally {
      setCreating(false);
    }
  }, [analysisResult, selectedAgents, contextFiles, projectId, name, path, color, onProjectCreated, onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="text-lg font-semibold text-white mb-4">Open Project</h2>

        <StepIndicator currentStep={step} />

        {/* Step 1: Select Folder */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Project Path</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/your/project"
                  className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                  autoFocus
                />
                {window.electronAPI?.isElectron && (
                  <button
                    onClick={async () => {
                      const dir = await window.electronAPI.selectDirectory();
                      if (dir) setPath(dir);
                    }}
                    className="px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-sm text-gray-200 transition-colors flex-shrink-0"
                    title="Browse..."
                  >
                    📂 Browse
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameManuallyEdited(true);
                  }}
                  placeholder="My Project"
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Project ID</label>
                <input
                  type="text"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setIdManuallyEdited(true);
                  }}
                  placeholder="my-project"
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Color</label>
              <div className="flex items-center gap-2 flex-wrap">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-8 h-8 rounded-full transition-all ${
                      color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900 scale-110' : 'hover:scale-105'
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
                <label className="relative w-8 h-8 rounded-full overflow-hidden cursor-pointer border-2 border-dashed border-gray-500 hover:border-gray-400 transition-colors flex items-center justify-center">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </label>
                <div
                  className="w-8 h-8 rounded-full border-2 border-gray-600 ml-1"
                  style={{ backgroundColor: color }}
                  title={`Selected: ${color}`}
                />
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={handleAnalyze}
                disabled={!path.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
              >
                Analyze Project
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Analysis */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Terminal output */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                {analyzing && <Spinner />}
                <span className="text-sm font-medium text-gray-300">
                  {analyzing ? 'Analyzing project...' : analysisError ? 'Analysis failed' : 'Analysis complete'}
                </span>
              </div>
              <div
                ref={terminalRef}
                className="bg-gray-950 font-mono text-xs text-green-400 p-4 rounded-lg max-h-64 overflow-y-auto whitespace-pre-wrap"
              >
                {progressText || (analyzing ? 'Waiting for output...' : '')}
              </div>
            </div>

            {/* Error state */}
            {analysisError && !analyzing && (
              <div className="space-y-3">
                <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                  {analysisError}
                </div>
                <button
                  onClick={() => { setStep(1); setAnalysisError(null); }}
                  className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                >
                  Back
                </button>
              </div>
            )}

            {/* Success state */}
            {analysisResult && !analyzing && (
              <div className="space-y-4">
                {/* Tech stack */}
                {analysisResult.techStack?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-2">Tech Stack</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {analysisResult.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded-full text-xs"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description */}
                {analysisResult.description && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-1">Description</h4>
                    <p className="text-sm text-gray-400">{analysisResult.description}</p>
                  </div>
                )}

                {/* Suggested agents — lead/sub hierarchy */}
                {analysisResult.agents?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-300 mb-2">Agent Team</h4>
                    <div className="space-y-2">
                      {analysisResult.agents.map((agent, i) => {
                        const isLead = agent.role === 'lead' || (i === 0 && analysisResult.agents.length > 1);
                        const isSub = !isLead && analysisResult.agents.length > 1;
                        return (
                          <div key={i} className={`bg-gray-800 rounded-lg p-3 border ${isLead ? 'border-amber-600/50' : 'border-gray-700'} ${isSub ? 'ml-6' : ''}`}>
                            <div className="flex items-center gap-2 mb-1">
                              {isSub && <span className="text-gray-600 text-xs">└</span>}
                              <span className="font-medium text-sm text-white">{agent.name}</span>
                              {isLead && (
                                <span className="bg-amber-900/50 text-amber-300 px-2 py-0.5 rounded-full text-xs font-medium">
                                  Lead
                                </span>
                              )}
                              {isSub && (
                                <span className="bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded-full text-xs">
                                  Sub-agent
                                </span>
                              )}
                            </div>
                            {agent.specialty && (
                              <p className="text-xs text-gray-400">{agent.specialty}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    onClick={() => { setStep(1); setAnalysisResult(null); setProgressText(''); }}
                    className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setStep(3)}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Review & Create */}
        {step === 3 && (
          <div className="space-y-4">
            {/* Agent cards with checkboxes */}
            {analysisResult?.agents?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-300 mb-2">Agent Team</h4>
                <div className="space-y-2">
                  {analysisResult.agents.map((agent, i) => {
                    const isLead = agent.role === 'lead' || (i === 0 && analysisResult.agents.length > 1);
                    const isSub = !isLead && analysisResult.agents.length > 1;
                    return (
                      <label
                        key={i}
                        className={`flex items-start gap-3 bg-gray-800 rounded-lg p-3 border cursor-pointer transition-colors ${isSub ? 'ml-6' : ''} ${
                          selectedAgents[i]
                            ? isLead ? 'border-amber-600/50' : 'border-emerald-600'
                            : 'border-gray-700 opacity-60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!!selectedAgents[i]}
                          onChange={() =>
                            setSelectedAgents((prev) => ({ ...prev, [i]: !prev[i] }))
                          }
                          className="mt-0.5 accent-emerald-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            {isSub && <span className="text-gray-600 text-xs">└</span>}
                            <span className="font-medium text-sm text-white">{agent.name}</span>
                            {isLead && (
                              <span className="bg-amber-900/50 text-amber-300 px-2 py-0.5 rounded-full text-xs font-medium">
                                Lead
                              </span>
                            )}
                            {isSub && (
                              <span className="bg-indigo-900/50 text-indigo-300 px-2 py-0.5 rounded-full text-xs">
                                Sub-agent
                              </span>
                            )}
                          </div>
                          {agent.specialty && (
                            <p className="text-xs text-gray-400">{agent.specialty}</p>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Context file tabs */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-2">Context Files</h4>
              <div className="flex gap-1 mb-2 flex-wrap">
                {CONTEXT_FILE_TABS.map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      activeTab === tab
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <textarea
                value={contextFiles[activeTab] || ''}
                onChange={(e) =>
                  setContextFiles((prev) => ({ ...prev, [activeTab]: e.target.value }))
                }
                rows={8}
                placeholder={`Content for ${activeTab}...`}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-y transition-colors"
              />
            </div>

            {/* Error */}
            {analysisError && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                {analysisError}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => { setStep(2); setAnalysisError(null); }}
                className="bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:text-emerald-300 text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
              >
                {creating && <Spinner size={4} />}
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

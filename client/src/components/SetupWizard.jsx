import React, { useState } from 'react';
import { Bot, Rocket } from 'lucide-react';

const API_BASE = '/api';

const STEP_LABELS = ['Welcome', 'Configure Claude', 'First Project'];

function StepIndicator({ currentStep }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
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

function ToggleSwitch({ enabled, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
        enabled ? 'bg-emerald-500' : 'bg-gray-600'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export default function SetupWizard({ onComplete, setupStatus }) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const claudeEngine = setupStatus?.engines?.['claude-code'] || {};

  const [claudePath, setClaudePath] = useState(claudeEngine.path || '');
  const [claudeEnabled, setClaudeEnabled] = useState(claudeEngine.available || false);

  const handleSaveAndContinue = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/setup/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeBin: claudeEnabled ? claudePath : '',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Configuration failed: ${res.status}`);
      }
      setStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-xl p-8">
        <StepIndicator currentStep={step} />

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div className="text-center space-y-6">
            <div className="text-gray-300">
              <Bot size={64} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white mb-3">
                Welcome to Agent Hub
              </h1>
              <p className="text-gray-400 text-sm leading-relaxed max-w-md mx-auto">
                Let's get you set up. First, we'll check which AI coding tools
                you have installed.
              </p>
            </div>
            <button
              onClick={() => setStep(2)}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step 2: CLI Setup */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="text-center mb-2">
              <h1 className="text-xl font-bold text-white mb-1">
                Configure Your Tools
              </h1>
              <p className="text-gray-400 text-sm">
                Agent Hub uses Claude Code to power your AI agents. Let's make sure it's set up.
              </p>
            </div>

            {/* Claude Code Card */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 rounded-full bg-purple-500 inline-block" />
                  <span className="font-medium text-white text-sm">Claude Code</span>
                </div>
                <ToggleSwitch enabled={claudeEnabled} onChange={setClaudeEnabled} />
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                {claudeEngine.available ? (
                  <>
                    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-emerald-400">Detected at {claudeEngine.path}</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span className="text-red-400">Not found</span>
                  </>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Binary Path</label>
                <input
                  type="text"
                  value={claudePath}
                  onChange={(e) => setClaudePath(e.target.value)}
                  placeholder="/usr/local/bin/claude"
                  disabled={!claudeEnabled}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-mono"
                />
              </div>
            </div>

            {/* Warning if not enabled */}
            {!claudeEnabled && (
              <p className="text-yellow-400 text-xs text-center">
                Claude Code must be enabled to continue.
              </p>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setStep(1)}
                className="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2.5 rounded-lg text-sm transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleSaveAndContinue}
                disabled={!claudeEnabled || saving}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 px-6 rounded-lg text-sm transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving && (
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {saving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Create First Project */}
        {step === 3 && (
          <div className="text-center space-y-6">
            <div className="text-gray-300">
              <Rocket size={48} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white mb-2">
                Open Your First Project
              </h1>
              <p className="text-gray-400 text-sm leading-relaxed max-w-sm mx-auto">
                Point Agent Hub at a code repository and we'll set up AI agents for it.
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={onComplete}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Open Project
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

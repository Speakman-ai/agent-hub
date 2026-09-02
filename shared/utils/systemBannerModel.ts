const ENGINE_DISPLAY: Record<string, string> = {
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor Agent',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
};

const MODEL_KNOWN_LABELS: Record<string, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-fable-5-1': 'Fable 5.1',
  // Retired from selection (superseded by Fable 5.1); label retained for history.
  'claude-fable-5': 'Fable 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-5': 'Sonnet',
  // Retired from selection; label retained for historical sessions.
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'composer-2.5': 'Composer 2.5',
  // Retired from selection (rejected under ChatGPT OAuth); labels retained for
  // historical sessions.
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.6': 'GPT-5.6',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.2': 'GPT-5.2',
  'grok-build': 'Grok Build',
  'grok-composer-2.5-fast': 'Composer 2.5 Fast',
  'grok-build-0.1': 'Grok Build',
};

function trimmed(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

export function modelPrimaryLabel(modelId: string | null | undefined): string {
  const id = trimmed(modelId);
  if (!id) return '';
  if (MODEL_KNOWN_LABELS[id]) return MODEL_KNOWN_LABELS[id];
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatSystemBannerModelLine({
  streamModel,
  sessionModel,
  sessionEngine,
}: {
  streamModel?: string | null;
  sessionModel?: string | null;
  sessionEngine?: string | null;
}): string {
  const fromStream = modelPrimaryLabel(streamModel);
  if (fromStream) return fromStream;
  const fromSession = modelPrimaryLabel(sessionModel);
  if (fromSession) return fromSession;
  const engName = sessionEngine && ENGINE_DISPLAY[sessionEngine];
  if (engName) return `${engName} · session default`;
  return 'Model not reported · use the engine & model picker';
}

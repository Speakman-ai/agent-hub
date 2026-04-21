import { stripAnsi } from './ansi-strip.js';
import type { EngineAuthUiStatus } from './cursor-auth-parse.js';

/**
 * Parse `codex login --device-auth` banner output (see `codex login --help`).
 * Official flow: open https://auth.openai.com/codex/device and enter the code.
 */
export function extractCodexDeviceUrl(text: string): string | null {
  const plain = stripAnsi(text);
  const m = plain.match(/https:\/\/auth\.openai\.com\/[^\s)\]]+/i);
  return m ? m[0] : null;
}

export function extractCodexDeviceUserCode(text: string): string | null {
  const plain = stripAnsi(text);
  const labeled = plain.match(/Enter this one-time code[^\n]*\n\s*([A-Z0-9]{2,}-[A-Z0-9]{2,})\b/i);
  if (labeled) return labeled[1];
  const loose = plain.match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/);
  return loose ? loose[1] : null;
}

export function computeCodexUiStatus(p: {
  binaryPresent: boolean;
  loginInProgress: boolean;
  apiKeyConfigured: boolean;
  /** ChatGPT OAuth tokens in ~/.codex/auth.json */
  chatgptOAuthFromFile: boolean;
  /** API key material persisted by the CLI in ~/.codex/auth.json (distinct from Hub env/config) */
  cliApiKeyFromFile: boolean;
}): EngineAuthUiStatus {
  if (!p.binaryPresent) return 'missing';
  if (p.loginInProgress) return 'pending';
  if (p.apiKeyConfigured || p.chatgptOAuthFromFile || p.cliApiKeyFromFile) return 'authenticated';
  return 'missing';
}

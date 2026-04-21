import { stripAnsi } from './ansi-strip.js';

/** Cursor Agent prints this line when `NO_OPEN_BROWSER=1` (see `agent login --help`). */
export function extractCursorLoginUrl(text: string): string | null {
  const plain = stripAnsi(text);
  const m = plain.match(/https:\/\/cursor\.com\/[^\s)\]]+/i);
  return m ? m[0] : null;
}

/**
 * If stdout is not pure JSON (e.g. log lines before `{`), extract the first
 * top-level `{ ... }` by brace depth. Do not use `lastIndexOf('{')` — nested
 * `userInfo` objects would steal the inner `{` and break parsing.
 */
function extractFirstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseCursorStatusJson(
  stdout: string,
  stderr: string,
): { ok: boolean; isAuthenticated: boolean; email?: string; error?: string } {
  const combined = (stdout || '').trim() || (stderr || '').trim();
  if (!combined) {
    return { ok: false, isAuthenticated: false, error: 'Empty response from cursor-agent status' };
  }
  const parsePayload = (raw: string) => {
    const j = JSON.parse(raw) as {
      isAuthenticated?: boolean;
      userInfo?: { email?: string };
    };
    return {
      ok: true as const,
      isAuthenticated: !!j.isAuthenticated,
      email: j.userInfo?.email,
    };
  };
  try {
    return parsePayload(combined);
  } catch {
    const extracted = extractFirstBalancedJsonObject(combined);
    if (extracted) {
      try {
        return parsePayload(extracted);
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      isAuthenticated: false,
      error: combined.slice(0, 240) || 'Invalid JSON from cursor-agent status',
    };
  }
}

export type EngineAuthUiStatus = 'missing' | 'pending' | 'authenticated';

export function computeCursorUiStatus(p: {
  binaryPresent: boolean;
  loginInProgress: boolean;
  isAuthenticated: boolean;
}): EngineAuthUiStatus {
  if (!p.binaryPresent) return 'missing';
  if (p.loginInProgress) return 'pending';
  if (p.isAuthenticated) return 'authenticated';
  return 'missing';
}

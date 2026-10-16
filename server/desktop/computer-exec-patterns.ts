/**
 * The computer tool's exec deny list: commands that always need the session
 * owner's approval, whatever the desktop app policy says. Kept free of DB
 * imports so config.ts can parse the setting.
 */

/**
 * Exec commands that always need a human's yes. Case-insensitive regexes.
 * Operators replace the list with `desktopExecApprovalPatterns` in
 * config.json (or env AGENT_HUB_DESKTOP_EXEC_APPROVAL_PATTERNS).
 */
export const DEFAULT_DESKTOP_EXEC_APPROVAL_PATTERNS: readonly string[] = [
  String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]`,
  String.raw`\bsudo\b`,
  String.raw`\bsu(\s|$)`,
  String.raw`\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`,
  String.raw`\b(mkfs|fdisk|parted|wipefs|shred)\b`,
  String.raw`\bdd\b[^|;&]*\bof=`,
  String.raw`\b(shutdown|reboot|poweroff|halt)\b`,
  String.raw`\bgit\s+push\b`,
  String.raw`\b(npm|yarn|pnpm)\s+publish\b`,
  String.raw`\b(ssh|scp|sftp|rsync)\b`,
  String.raw`\b(chmod|chown)\s+(-[a-z]*\s+)*-[a-z]*R`,
  String.raw`\bcrontab\b`,
  String.raw`:\(\)\s*\{`,
];

export interface CompiledExecPattern {
  source: string;
  re: RegExp;
}

/**
 * Compile the deny list. A pattern that is not a valid regex is matched as a
 * literal substring instead of being dropped, so a typo never silently
 * removes a guard.
 */
export function compileExecApprovalPatterns(
  patterns: readonly string[] | null | undefined,
): CompiledExecPattern[] {
  const list = patterns ?? DEFAULT_DESKTOP_EXEC_APPROVAL_PATTERNS;
  const out: CompiledExecPattern[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let re: RegExp;
    try {
      re = new RegExp(raw, 'i');
    } catch {
      re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    out.push({ source: raw, re });
  }
  return out;
}

/** The first deny-list pattern `command` matches, or null. */
export function matchExecApprovalPattern(
  command: string,
  patterns: readonly CompiledExecPattern[],
): string | null {
  return patterns.find((p) => p.re.test(command))?.source ?? null;
}

/** Read the config value: a string array, a JSON array string, or newline-separated text. */
export function coerceExecApprovalPatterns(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // Fall through to newline splitting.
    }
  }
  return t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

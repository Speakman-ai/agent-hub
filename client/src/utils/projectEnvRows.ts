/**
 * Reserved env-var namespace — mirrors the server's `RESERVED_KEY_RE`
 * (`server/preview/reserved-env-keys.ts`). These are server-injected at
 * spawn time and the secrets store hard-rejects them, so they must never
 * render as an editable preview env row or be sent in the build payload.
 */
export const RESERVED_ENV_KEY_RE = /^(AGENT_HUB_|NODE_|PATH$|HOME$)/;

export function isReservedEnvKey(key: any) {
  return typeof key === 'string' && RESERVED_ENV_KEY_RE.test(key);
}

/**
 * Merge scanned env-var suggestions with saved project secrets for settings UI.
 */
export function envRowsFromDraftAndSecrets(draft: any, secrets: any = []) {
  const secretByKey = new Map((secrets || []).map((s: any) => [s.key, s]));
  const suggestions = draft?.envVars || [];
  const keys = new Set(suggestions.map((s: any) => s.key));
  for (const s of secrets || []) keys.add(s.key);
  return [...keys]
    .filter((key: any) => !isReservedEnvKey(key))
    .sort((a: any, b: any) => a.localeCompare(b))
    .map((key: any) => {
      const sug = suggestions.find((s: any) => s.key === key);
      const saved = secretByKey.get(key);
      return {
        key,
        value: (saved as any)?.kind === 'plain' ? (saved as any).value || '' : '',
        kind: (saved as any)?.kind === 'plain' ? 'plain' : 'secret',
        hadSecret: (saved as any)?.kind === 'secret',
        sources: sug?.sources || (saved ? ['saved'] : []),
        required: !!sug?.required,
        configured: Boolean(saved),
      };
    });
}

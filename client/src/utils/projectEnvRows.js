/**
 * Merge scanned env-var suggestions with saved project secrets for settings UI.
 */
export function envRowsFromDraftAndSecrets(draft, secrets = []) {
  const secretByKey = new Map((secrets || []).map((s) => [s.key, s]));
  const suggestions = draft?.envVars || [];
  const keys = new Set(suggestions.map((s) => s.key));
  for (const s of secrets || []) keys.add(s.key);
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const sug = suggestions.find((s) => s.key === key);
      const saved = secretByKey.get(key);
      return {
        key,
        value: saved?.kind === 'plain' ? saved.value || '' : '',
        kind: saved?.kind === 'plain' ? 'plain' : 'secret',
        hadSecret: saved?.kind === 'secret',
        sources: sug?.sources || (saved ? ['saved'] : []),
        required: !!sug?.required,
        configured: Boolean(saved),
      };
    });
}

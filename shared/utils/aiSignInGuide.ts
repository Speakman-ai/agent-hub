export function aiSignInGuideKey(
  server: string,
  user?: { id?: string; email?: string; username?: string } | null,
) {
  return `ai-sign-in-guide:${JSON.stringify([server.replace(/\/+$/, ''), user?.id || user?.email || user?.username || 'local'])}`;
}

export function needsAiSignInGuide(
  status: { authConfigured?: boolean; hasAnyAiCredentials?: boolean } | null | undefined,
) {
  return status?.authConfigured !== false && status?.hasAnyAiCredentials === false;
}

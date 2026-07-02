// Pure helpers for the per-environment notification-routing surface.
// Framework-free so they can be unit-tested and mirrored by the mobile screen.
// Backend contract lives in server/deploy/deployment-notification-routing-store.ts
// (env-name default resolution + type toggles).

export interface NotificationRouting {
  environmentName: string;
  isProduction: boolean;
  ticketReleaseEnabled: boolean;
  releaseDigestEnabled: boolean;
  isDefault: boolean;
  updatedAt: string | null;
}

/** Human sentence describing which release notifications an env will send. */
export function summarizeRouting(routing: {
  ticketReleaseEnabled: boolean;
  releaseDigestEnabled: boolean;
}): string {
  const parts: string[] = [];
  if (routing.ticketReleaseEnabled) parts.push('reporter emails');
  if (routing.releaseDigestEnabled) parts.push('release digest');
  if (parts.length === 0) return 'Sends nothing on a successful deploy';
  return `Sends ${parts.join(' + ')} on a successful deploy`;
}

/** Label for the default-vs-override state chip. */
export function routingDefaultLabel(routing: {
  isDefault: boolean;
  isProduction: boolean;
}): string {
  if (!routing.isDefault) return 'custom';
  return routing.isProduction ? 'default (prod)' : 'default (off)';
}

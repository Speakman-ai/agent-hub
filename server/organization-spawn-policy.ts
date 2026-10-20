/** Dependency-free bridge: config is imported before the session DB exists. The
 * auth/runtime module installs the policy during server initialization. */
import type { AppConfig } from './types.js';
export interface OrganizationSpawnPolicy {
  matches(sessionId: string): boolean;
  apply(env: NodeJS.ProcessEnv, sessionId: string, userId: string | null, cfg: AppConfig): void;
}
let policy: OrganizationSpawnPolicy | undefined;
export function registerOrganizationSpawnPolicy(value: OrganizationSpawnPolicy): void {
  policy = value;
}
export function getOrganizationSpawnPolicy(
  sessionId: string | null | undefined,
): OrganizationSpawnPolicy | null {
  return sessionId && policy?.matches(sessionId) ? policy : null;
}

const revalidators = new Set<() => void>();
export function registerOrganizationAccessRevalidator(handler: () => void): void {
  revalidators.add(handler);
}
/** Synchronous notification after authority mutations, including remove-and-readd within a turn. */
export function revalidateOrganizationAccess(): void {
  for (const handler of revalidators) {
    try {
      handler();
    } catch {
      /* One failing listener must not skip revocation in the others. */
    }
  }
}

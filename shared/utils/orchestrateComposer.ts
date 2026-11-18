/**
 * Composer copy for an Orchestrate chat, shared by web and mobile so both
 * surfaces say the same thing in Simple and full view. Null for other modes.
 */
export interface OrchestrateComposerCopy {
  hint: string;
  placeholder: string;
}

export const ORCHESTRATE_COMPOSER_COPY: OrchestrateComposerCopy = {
  hint: 'Orchestrate — this chat starts other sessions and does not ship',
  placeholder: 'Plan the work, then start a session…',
};

export function orchestrateComposerCopy(
  sessionMode: string | null | undefined,
): OrchestrateComposerCopy | null {
  return sessionMode === 'orchestrate' ? ORCHESTRATE_COMPOSER_COPY : null;
}

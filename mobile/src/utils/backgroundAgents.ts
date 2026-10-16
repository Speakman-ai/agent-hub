const DEFAULT_SCHEDULE = '0 3 * * *';

/**
 * PATCH body for background agents. Preserves fields the mobile form does not
 * edit (owner, model, skills) so a save cannot wipe the web configuration.
 */
export function backgroundAgentsPatch(
  wiki: any,
  custom: any[],
  projectMode?: string,
): { backgroundAgents: { wiki: any; custom: any[] } } {
  return {
    backgroundAgents: {
      wiki: {
        ...wiki,
        enabled: !!wiki?.enabled,
        schedule: wiki?.schedule || DEFAULT_SCHEDULE,
      },
      custom: custom.map((agent) => ({
        ...agent,
        name: String(agent?.name || '').trim(),
        prompt: agent?.prompt || '',
        enabled: !!agent?.enabled,
        schedule: agent?.schedule || DEFAULT_SCHEDULE,
        sessionMode: agent?.sessionMode || (projectMode === 'workflow' ? 'consult' : 'manual'),
      })),
    },
  };
}

export const DEFAULT_BACKGROUND_SCHEDULE = DEFAULT_SCHEDULE;

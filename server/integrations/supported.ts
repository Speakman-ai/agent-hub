/**
 * SUPPORTED_INTEGRATIONS — canonical list of third-party apps that
 * Agent Hub's per-user Settings → Integrations page knows how to
 * connect via the configured IntegrationProvider (Nango).
 *
 * The `id` field is the provider config key (`providerConfigKey` in
 * Nango parlance) — it must exactly match the integration slug
 * registered with the upstream Nango project. The `app` value used in
 * `/api/users/:userId/integrations/:app/*` routes is the same string.
 *
 * `label`, `description`, `category`, and `docsUrl` are presentation-
 * only metadata — they drive the rendered card on the frontend without
 * having to ship a parallel constant client-side. Adding a new
 * supported app is a one-line addition here plus a new providerConfig
 * in Nango.
 */
export interface SupportedIntegration {
  /** Provider config key (Nango). Same string is used as `:app` in URLs. */
  id: string;
  /** Display name shown on the card. */
  label: string;
  /** One-sentence blurb explaining what connecting unlocks. */
  description: string;
  /** Loose grouping label — currently informational only. */
  category: 'communication' | 'email' | 'developer' | 'productivity' | 'crm';
  /** Optional doc URL the UI can link to ("Learn more"). */
  docsUrl?: string;
}

export const SUPPORTED_INTEGRATIONS: readonly SupportedIntegration[] = Object.freeze([
  {
    id: 'slack',
    label: 'Slack',
    description: 'Post messages and read channels from agents in your Slack workspaces.',
    category: 'communication',
    docsUrl: 'https://slack.com/intl/en-gb/help/articles/202035138',
  },
  {
    id: 'google-mail',
    label: 'Gmail',
    description: 'Read and send email on your behalf from Agent Hub agents.',
    category: 'email',
    docsUrl: 'https://support.google.com/mail',
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Per-user GitHub access for opening PRs, reading issues, and reviewing code.',
    category: 'developer',
    docsUrl: 'https://docs.github.com/en/rest',
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Search Notion pages and append updates from agent runs.',
    category: 'productivity',
    docsUrl: 'https://developers.notion.com',
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    description: 'Read CRM contacts and deals; create activity entries from agents.',
    category: 'crm',
    docsUrl: 'https://developers.hubspot.com',
  },
] as const);

/** Lookup helper — `null` when the app is not in the supported list. */
export function findSupportedIntegration(id: string): SupportedIntegration | null {
  return SUPPORTED_INTEGRATIONS.find((i) => i.id === id) ?? null;
}

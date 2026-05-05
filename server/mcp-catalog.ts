/**
 * MCP server catalog — well-known integrations the Settings UI surfaces as
 * one-click "Add" tiles. Each entry is a template: the user picks one,
 * fills in the required env / header values, and the server materialises
 * an `mcp_servers` row from it.
 *
 * Scope for v1 (per user request): Linear, Notion, GitHub, plus a "custom"
 * escape hatch handled directly by the Settings UI (bypasses the catalog).
 *
 * Adding a new entry: just append to `MCP_CATALOG` below — no code changes
 * elsewhere. The `id` becomes the `catalog_id` foreign-key value on the
 * created `mcp_servers` row, useful for future "is this still up-to-date
 * with the latest catalog template?" UX.
 */

export type McpCatalogTransport = 'stdio' | 'http';

export interface McpCatalogEnvField {
  /** Env var (stdio) or header name (http) the value will be stored under. */
  key: string;
  /** Human label for the Settings form. */
  label: string;
  /** Short hint shown under the input. */
  helpText: string;
  /** Mark fields that the user is expected to fill in (no default value). */
  required: boolean;
  /** Treat as secret — masked on read, supports MASK round-trip on write. */
  secret: boolean;
  /** Optional default value. */
  default?: string;
  /** Optional `<a href>` to the page that mints this credential. */
  docsUrl?: string;
}

export interface McpCatalogEntry {
  /** Stable slug — stored as `catalog_id`. */
  id: string;
  /** Display name (also used as the default `mcp_servers.name`). */
  name: string;
  /** Short pitch shown on the catalog tile. */
  description: string;
  /** Documentation URL — typically the upstream MCP server's repo. */
  homepageUrl: string;
  /** Transport. */
  transport: McpCatalogTransport;
  /** stdio: command to run. */
  command?: string;
  /** stdio: command args. */
  args?: string[];
  /** http: server URL. */
  url?: string;
  /** stdio: env-var fields the user fills in. */
  env?: McpCatalogEnvField[];
  /** http: header fields the user fills in. */
  headers?: McpCatalogEnvField[];
}

/**
 * v1 catalog. Each entry references the *upstream* MCP server, not a
 * Hub-shipped binary — Agent Hub doesn't host any of these processes;
 * Claude Code / Cursor spawn them on the user's behalf when the
 * `--mcp-config` payload is read.
 *
 * Sources:
 *   - Linear: https://github.com/linear/linear-mcp (HTTP transport, OAuth or API key)
 *   - Notion: https://github.com/makenotion/notion-mcp-server (stdio + NOTION_API_KEY)
 *   - GitHub: https://github.com/github/github-mcp-server (HTTP at api.githubcopilot.com/mcp,
 *     Bearer auth with a GitHub PAT or the user's already-connected OAuth token)
 *
 * If/when these projects publish v2 contracts, update the entries here —
 * the `catalog_id` foreign key in the `mcp_servers` rows lets us migrate
 * existing user configs in place.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Read and write Linear issues, projects, and cycles.',
    homepageUrl: 'https://linear.app/changelog/2025-05-01-mcp',
    transport: 'http',
    url: 'https://mcp.linear.app/sse',
    headers: [
      {
        key: 'Authorization',
        label: 'API Key',
        helpText:
          'Personal API key from Linear → Settings → API. Format: "Bearer lin_api_…". Linear also supports OAuth — see their docs.',
        required: true,
        secret: true,
        docsUrl: 'https://linear.app/settings/api',
      },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search Notion pages and databases, read content, append blocks.',
    homepageUrl: 'https://github.com/makenotion/notion-mcp-server',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: [
      {
        key: 'OPENAPI_MCP_HEADERS',
        label: 'Notion API headers (JSON)',
        helpText:
          'JSON object containing `Authorization: Bearer …` and `Notion-Version: 2022-06-28`. Get the integration token at notion.so/profile/integrations.',
        required: true,
        secret: true,
        docsUrl: 'https://www.notion.so/profile/integrations',
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read repos, issues, PRs, code search via the official GitHub MCP server.',
    homepageUrl: 'https://github.com/github/github-mcp-server',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [
      {
        key: 'Authorization',
        label: 'GitHub token',
        helpText:
          'Personal access token (classic or fine-grained) with the scopes you need. Format: "Bearer ghp_…". Hub already manages a per-user GitHub OAuth connection — paste a token here only if you want a different identity for MCP than the one Agent Hub uses for git push.',
        required: true,
        secret: true,
        docsUrl: 'https://github.com/settings/tokens',
      },
    ],
  },
];

export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

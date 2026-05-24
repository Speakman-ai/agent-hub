/**
 * Compose preview onboarding checklist — contract between Agent Hub and
 * project `compose.preview.yml` files. Surfaced in Settings draft scan
 * and the preview setup wizard kickoff prompt.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export type ComposeChecklistStatus = 'pass' | 'warn' | 'fail' | 'manual';

export interface ComposePreviewChecklistItem {
  /** Stable id for tests and wizard references. */
  id: string;
  category: 'mount' | 'ports' | 'health' | 'runtime' | 'deploy';
  title: string;
  description: string;
  /** `manual` = operator verifies; `auto` = repo scan when compose file exists. */
  kind: 'manual' | 'auto';
  status: ComposeChecklistStatus;
  hint?: string;
}

export interface ComposeChecklistScanInput {
  workspaceDir: string;
  composeFile?: string;
  entryService?: string | null;
  entryPort?: number;
  healthPath?: string;
}

/** Bind source paths in `volumes:` (list or long syntax). */
const ABSOLUTE_BIND_RE = /['"]?\/(?:Users|home|var|tmp|opt)\/[^\s'"]*/;
const RELATIVE_BIND_RE = /['"]?\.\/[^\s'"]*/;
const CONTAINER_NAME_RE = /^\s*container_name\s*:/m;
const AGENTHUB_PORT_RE = /\$\{AGENTHUB_HOST_PORT/;
const FRONTEND_PORT_RE = /\$\{FRONTEND_PORT/;
const CHOKIDAR_RE = /CHOKIDAR_USEPOLLING|WATCHPACK_POLLING|--poll\s+\d+/;

function readComposeText(workspaceDir: string, composeFile: string): string | null {
  const resolved = path.join(workspaceDir, composeFile);
  if (!existsSync(resolved)) return null;
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

function entryServiceBlock(composeText: string, entryService: string): string | null {
  const escaped = entryService.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)\\s{2}${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s{2}[a-zA-Z0-9][a-zA-Z0-9_.-]*\\s*:|\\n[a-zA-Z]+:|$)`,
    'm',
  );
  const m = composeText.match(re);
  return m?.[1] ?? null;
}

function manualItems(healthPath: string): ComposePreviewChecklistItem[] {
  return [
    {
      id: 'worktree-bind-mounts',
      category: 'mount',
      title: 'Bind mounts are relative to the session worktree',
      description:
        'Agent Hub runs `docker compose` with `--project-directory` set to the session worktree (not project.cwd). Use paths like `./frontend:/app`, never a fixed host checkout path.',
      kind: 'manual',
      status: 'manual',
      hint: 'Preview edits and git worktrees live under ~/.agent-hub/.../workspaces/<project>/session-<id>/',
    },
    {
      id: 'health-on-entry-url',
      category: 'health',
      title: 'Health check hits the browser entry URL',
      description:
        'Hub polls `http://<allocated-host-port><healthPath>` until HTTP 2xx. The path must be served by the entry service (usually the UI dev server), not only the API container.',
      kind: 'manual',
      status: 'manual',
      hint: `Configured healthPath: ${healthPath} — use \`/\` for ng serve/Vite unless the entry proxies your API health route.`,
    },
    {
      id: 'mac-file-watching',
      category: 'runtime',
      title: 'File watching works through Docker bind mounts (macOS/Windows)',
      description:
        'On Docker Desktop, inotify often misses host edits. Set `CHOKIDAR_USEPOLLING=true` and/or `ng serve --poll 2000` (or equivalent) on the entry service.',
      kind: 'manual',
      status: 'manual',
    },
    {
      id: 'deploy-workspaces-dir',
      category: 'deploy',
      title: 'Production Hub: workspace path translation',
      description:
        'When Agent Hub runs inside Docker, set `AGENT_HUB_HOST_WORKSPACES_DIR` to the host path backing `/data/.agent-hub/workspaces` so previews mount session worktrees, not project.cwd.',
      kind: 'manual',
      status: 'manual',
      hint: 'See repo `docker-compose.yml` — also set `AGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal` (or equivalent).',
    },
    {
      id: 'session-worktree-before-preview',
      category: 'deploy',
      title: 'Start preview after the session worktree exists',
      description:
        'Open the chat session (or wait for “Preparing workspace…”) before Start preview so compose uses the same tree the agent edits.',
      kind: 'manual',
      status: 'manual',
    },
  ];
}

function autoScanCompose(
  composeText: string | null,
  entryService: string | null,
  entryPort: number,
): ComposePreviewChecklistItem[] {
  const items: ComposePreviewChecklistItem[] = [];

  if (!composeText) {
    items.push({
      id: 'compose-file-readable',
      category: 'mount',
      title: 'Compose file present for scan',
      description: 'No compose file on disk yet — generate or bootstrap first, then rescan.',
      kind: 'auto',
      status: 'warn',
    });
    return items;
  }

  items.push({
    id: 'compose-file-readable',
    category: 'mount',
    title: 'Compose file present for scan',
    description: 'Compose file was read for automated checks below.',
    kind: 'auto',
    status: 'pass',
  });

  const hasRelative = RELATIVE_BIND_RE.test(composeText);
  const hasAbsolute = ABSOLUTE_BIND_RE.test(composeText);
  items.push({
    id: 'relative-volume-paths',
    category: 'mount',
    title: 'Volume sources use relative paths',
    description: hasRelative
      ? 'Found `./…` bind-mount sources.'
      : 'No `./` bind-mount sources detected — add relative paths so worktree mounts work.',
    kind: 'auto',
    status: hasRelative && !hasAbsolute ? 'pass' : hasAbsolute ? 'fail' : 'warn',
    hint: hasAbsolute
      ? 'Remove absolute host paths like /Users/... or /home/... from `volumes:`.'
      : undefined,
  });

  items.push({
    id: 'no-fixed-container-name',
    category: 'deploy',
    title: 'No fixed container_name on services',
    description:
      'Concurrent session previews require compose project isolation; `container_name:` breaks parallel previews.',
    kind: 'auto',
    status: CONTAINER_NAME_RE.test(composeText) ? 'fail' : 'pass',
  });

  const entry = entryService ? entryServiceBlock(composeText, entryService) : null;
  const entryScope = entry ?? composeText;
  const usesAgentHubPort = AGENTHUB_PORT_RE.test(entryScope) || AGENTHUB_PORT_RE.test(composeText);
  const usesFrontendPort = FRONTEND_PORT_RE.test(entryScope) || FRONTEND_PORT_RE.test(composeText);
  items.push({
    id: 'host-port-env-vars',
    category: 'ports',
    title: 'Host port uses AGENTHUB_HOST_PORT or FRONTEND_PORT',
    description:
      'Hub sets `AGENTHUB_HOST_PORT` (allocated) and `FRONTEND_PORT` (entry internal port, e.g. 4200). Map `${AGENTHUB_HOST_PORT:-…}:${FRONTEND_PORT:-4200}` or rely on the Hub port override file.',
    kind: 'auto',
    status: usesAgentHubPort || usesFrontendPort ? 'pass' : 'warn',
    hint:
      !usesAgentHubPort && !usesFrontendPort
        ? 'Hub still injects a per-session ports override; document FRONTEND_PORT in the entry service command.'
        : undefined,
  });

  const portLiteral = String(entryPort);
  const listensOnEntryPort =
    entryScope.includes(`:${portLiteral}`) ||
    entryScope.includes(`port ${portLiteral}`) ||
    entryScope.includes(`PORT`) ||
    usesFrontendPort;
  items.push({
    id: 'entry-listens-entry-port',
    category: 'ports',
    title: `Entry service targets internal port ${entryPort}`,
    description:
      'The dev server inside the entry container must listen on `entryPort` (Hub `FRONTEND_PORT`), not only on the allocated host port.',
    kind: 'auto',
    status: listensOnEntryPort ? 'pass' : 'warn',
    hint: `Set prEnv.preview.compose.entryPort to match ng serve / Vite (often 4200 or 3000).`,
  });

  items.push({
    id: 'docker-polling-hints',
    category: 'runtime',
    title: 'Compose hints at poll-based file watching',
    description: 'Detected CHOKIDAR_USEPOLLING, WATCHPACK_POLLING, or `--poll` in compose/entry.',
    kind: 'auto',
    status: CHOKIDAR_RE.test(composeText) ? 'pass' : 'warn',
  });

  return items;
}

/**
 * Build the full checklist for a workspace + optional detected compose metadata.
 */
export function buildComposePreviewChecklist(
  input: ComposeChecklistScanInput,
): ComposePreviewChecklistItem[] {
  const composeFile = (input.composeFile ?? 'compose.preview.yml').trim() || 'compose.preview.yml';
  const healthPath = (input.healthPath ?? '/').trim() || '/';
  const entryPort =
    typeof input.entryPort === 'number' && Number.isFinite(input.entryPort)
      ? input.entryPort
      : 4200;
  const entryService = input.entryService?.trim() || null;
  const composeText = readComposeText(input.workspaceDir, composeFile);

  return [...manualItems(healthPath), ...autoScanCompose(composeText, entryService, entryPort)];
}

/** Markdown bullet list for wizard / agent prompts. */
export function formatComposeChecklistForPrompt(items: ComposePreviewChecklistItem[]): string {
  const lines = [
    '## Compose preview checklist',
    '',
    'Verify each item with the user; fix **fail** before `preview/build`.',
    '',
  ];
  for (const item of items) {
    const badge =
      item.status === 'pass'
        ? 'PASS'
        : item.status === 'fail'
          ? 'FAIL'
          : item.status === 'warn'
            ? 'WARN'
            : 'CHECK';
    lines.push(`- **[${badge}]** (${item.category}) ${item.title}`);
    lines.push(`  ${item.description}`);
    if (item.hint) lines.push(`  _Hint:_ ${item.hint}`);
  }
  return lines.join('\n');
}

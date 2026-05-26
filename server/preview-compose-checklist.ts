/**
 * Compose preview onboarding checklist — contract between Agent Hub and
 * project `compose.preview.yml` files. Surfaced in Settings draft scan
 * and the preview setup wizard kickoff prompt.
 *
 * Every item here is the result of an automated scan: each one resolves
 * to `pass | warn | fail`. There is no "manual / always show CHECK" tier
 * — those were dropped because they rendered as unresolved-forever rows
 * in Settings → Preview environment and duplicated checks that the
 * auto-scan already performs (relative-volume-paths, docker-polling-hints).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export type ComposeChecklistStatus = 'pass' | 'warn' | 'fail';

export interface ComposePreviewChecklistItem {
  /** Stable id for tests and wizard references. */
  id: string;
  category: 'mount' | 'ports' | 'health' | 'runtime' | 'deploy';
  title: string;
  description: string;
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
      status: 'warn',
    });
    return items;
  }

  items.push({
    id: 'compose-file-readable',
    category: 'mount',
    title: 'Compose file present for scan',
    description: 'Compose file was read for automated checks below.',
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
    status: listensOnEntryPort ? 'pass' : 'warn',
    hint: `Set prEnv.preview.compose.entryPort to match ng serve / Vite (often 4200 or 3000).`,
  });

  items.push({
    id: 'docker-polling-hints',
    category: 'runtime',
    title: 'Compose hints at poll-based file watching',
    description: 'Detected CHOKIDAR_USEPOLLING, WATCHPACK_POLLING, or `--poll` in compose/entry.',
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
  const entryPort =
    typeof input.entryPort === 'number' && Number.isFinite(input.entryPort)
      ? input.entryPort
      : 4200;
  const entryService = input.entryService?.trim() || null;
  const composeText = readComposeText(input.workspaceDir, composeFile);

  return autoScanCompose(composeText, entryService, entryPort);
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
    const badge = item.status === 'pass' ? 'PASS' : item.status === 'fail' ? 'FAIL' : 'WARN';
    lines.push(`- **[${badge}]** (${item.category}) ${item.title}`);
    lines.push(`  ${item.description}`);
    if (item.hint) lines.push(`  _Hint:_ ${item.hint}`);
  }
  return lines.join('\n');
}

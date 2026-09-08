import path from 'path';
import { HostWorktreeIo, type SessionWorktreeIo } from './session-env/worktree-io.js';
import type { StreamEvent } from './types.js';

type CodexChange = {
  path?: unknown;
  kind?: unknown;
  unified_diff?: unknown;
  unifiedDiff?: unknown;
  diff?: unknown;
  patch?: unknown;
  patchContent?: unknown;
  patch_content?: unknown;
  content?: unknown;
};

type GitDiffRunner = (cwd: string, filePath: string) => string | Promise<string>;
type ToolUseIdSet = Set<string>;

const PATCH_FIELDS = [
  'unified_diff',
  'unifiedDiff',
  'diff',
  'patch',
  'patchContent',
  'patch_content',
] as const;

function hasPatchText(change: CodexChange): boolean {
  return PATCH_FIELDS.some((field) => {
    const value = change[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;

export type CodexDiffOptions = {
  runGitDiff?: GitDiffRunner;
  fileChangeToolUseIds?: ToolUseIdSet;
  worktreeIo?: Pick<SessionWorktreeIo, 'git' | 'stat' | 'readFile'>;
  /** Worktree root in the CLI's filesystem namespace, including inside guests. */
  worktreeRoot?: string;
};

function relativeChangePath(root: string, cwd: string, filePath: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(cwd, filePath));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

async function enrichChanges(
  changes: CodexChange[],
  cwd: string,
  opts: CodexDiffOptions,
): Promise<{ changes: CodexChange[]; touched: boolean }> {
  const root = opts.worktreeRoot ?? cwd;
  const io = opts.worktreeIo ?? new HostWorktreeIo(root);
  let touched = false;
  const enriched: CodexChange[] = [];
  for (const change of changes) {
    enriched.push(change);
    if (
      !change ||
      typeof change !== 'object' ||
      hasPatchText(change) ||
      typeof change.content === 'string'
    )
      continue;
    if (typeof change.path !== 'string' || change.path.length === 0) continue;
    const relativePath = relativeChangePath(root, cwd, change.path);
    if (relativePath === null) continue;

    let unifiedDiff = '';
    try {
      if (opts.runGitDiff) {
        unifiedDiff = await opts.runGitDiff(cwd, change.path);
      } else {
        const result = await io.git(
          [
            '--literal-pathspecs',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            'HEAD',
            '--',
            relativePath,
          ],
          { timeoutMs: 5000, maxBuffer: MAX_DIFF_BYTES },
        );
        if (result.exitCode === 0) unifiedDiff = result.stdout;
      }
    } catch {
      // New, untracked files can still be displayed without a Git baseline.
    }

    if (unifiedDiff.trim() && Buffer.byteLength(unifiedDiff) <= MAX_DIFF_BYTES) {
      touched = true;
      enriched[enriched.length - 1] = { ...change, unified_diff: unifiedDiff };
      continue;
    }

    if (String(change.kind ?? '').toLowerCase() === 'add') {
      try {
        const stat = await io.stat(relativePath);
        if (!stat || stat.kind !== 'file' || stat.size > MAX_CONTENT_BYTES) continue;
        const bytes = await io.readFile(relativePath);
        if (bytes.length > MAX_CONTENT_BYTES || bytes.includes(0)) continue;
        touched = true;
        enriched[enriched.length - 1] = { ...change, content: bytes.toString('utf8') };
      } catch {}
    }
  }
  return { changes: enriched, touched };
}

export async function enrichCodexFileChangeDiffs(
  events: StreamEvent[],
  cwd: string,
  opts: CodexDiffOptions = {},
): Promise<StreamEvent[]> {
  const fileChangeToolUseIds = opts.fileChangeToolUseIds ?? new Set<string>();
  const enriched: StreamEvent[] = [];
  for (const event of events) {
    enriched.push(event);
    if (event.type === 'tool_use') {
      if (event.tool === 'Edit' && Array.isArray(event.input?.changes)) {
        fileChangeToolUseIds.add(event.id);
      }
      continue;
    }
    if (event.type !== 'tool_result' || !fileChangeToolUseIds.has(event.toolUseId)) continue;
    fileChangeToolUseIds.delete(event.toolUseId);
    if (event.isError) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.output);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const { changes, touched } = await enrichChanges(parsed as CodexChange[], cwd, opts);
    if (touched) enriched[enriched.length - 1] = { ...event, output: JSON.stringify(changes) };
  }
  return enriched;
}

/** Keep async worktree reads ahead of later chunks and turn finalization. */
export function createCodexFileChangeEventHandler(
  cwd: string,
  handleEvent: (event: StreamEvent) => void,
  opts: CodexDiffOptions = {},
) {
  const fileChangeToolUseIds = new Set<string>();
  let pending = Promise.resolve();
  return {
    enqueue(events: StreamEvent[]): void {
      pending = pending
        .then(async () => {
          const enriched = await enrichCodexFileChangeDiffs(events, cwd, {
            ...opts,
            fileChangeToolUseIds,
          });
          for (const event of enriched) handleEvent(event);
        })
        .catch((err: unknown) => {
          console.warn('[codex-diff] Could not process file-change events:', err);
        });
    },
    drain: () => pending,
  };
}

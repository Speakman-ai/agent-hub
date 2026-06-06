import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
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

type GitDiffRunner = (cwd: string, filePath: string) => string;
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

function defaultGitDiff(cwd: string, filePath: string): string {
  return execFileSync('git', ['diff', 'HEAD', '--', filePath], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function readAddedFileContent(cwd: string, filePath: string): string {
  const abs = path.resolve(cwd, filePath);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return '';
  if (!existsSync(abs)) return '';
  const content = readFileSync(abs, 'utf8');
  return content.length > 512 * 1024 ? `${content.slice(0, 512 * 1024)}\n...` : content;
}

function enrichChanges(
  changes: CodexChange[],
  cwd: string,
  runGitDiff: GitDiffRunner,
): { changes: CodexChange[]; touched: boolean } {
  let touched = false;
  const enriched = changes.map((change) => {
    if (!change || typeof change !== 'object' || hasPatchText(change)) return change;
    if (typeof change.path !== 'string' || change.path.length === 0) return change;

    let unifiedDiff = '';
    try {
      unifiedDiff = runGitDiff(cwd, change.path);
    } catch {
      unifiedDiff = '';
    }

    if (unifiedDiff.trim()) {
      touched = true;
      return { ...change, unified_diff: unifiedDiff };
    }

    if (String(change.kind ?? '').toLowerCase() === 'add') {
      try {
        const content = readAddedFileContent(cwd, change.path);
        if (content.length > 0) {
          touched = true;
          return { ...change, content };
        }
      } catch {}
    }

    return change;
  });

  return { changes: enriched, touched };
}

export function enrichCodexFileChangeDiffs(
  events: StreamEvent[],
  cwd: string,
  opts: { runGitDiff?: GitDiffRunner; fileChangeToolUseIds?: ToolUseIdSet } = {},
): StreamEvent[] {
  const runGitDiff = opts.runGitDiff ?? defaultGitDiff;
  const fileChangeToolUseIds = opts.fileChangeToolUseIds ?? new Set<string>();
  return events.map((event) => {
    if (event.type === 'tool_use') {
      const changes = event.input?.changes;
      if (event.tool === 'Edit' && Array.isArray(changes)) {
        fileChangeToolUseIds.add(event.id);
      }
      return event;
    }

    if (event.type !== 'tool_result') return event;
    if (!fileChangeToolUseIds.has(event.toolUseId)) return event;
    fileChangeToolUseIds.delete(event.toolUseId);

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.output);
    } catch {
      return event;
    }
    if (!Array.isArray(parsed)) return event;
    const { changes, touched } = enrichChanges(parsed as CodexChange[], cwd, runGitDiff);
    if (!touched) return event;
    return { ...event, output: JSON.stringify(changes) };
  });
}

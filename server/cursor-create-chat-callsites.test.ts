import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'default-skills', '.git']);

/** The one module allowed to exec `create-chat` — it owns the timeout rail. */
const OWNER = 'cursor-create-chat.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// Guard, not a unit test. Cursor's `create-chat` is spawned from four
// independent paths (chat, Design Studio, multi-agent conference, Finalize
// reviewer) and each one was originally its own copy-pasted unbounded
// `execFile`. An unbounded one strands whatever is awaiting it — a chat turn
// stuck "thinking" forever, or a Finalize run idling to its 60-minute cap.
// This fails the moment a fifth copy appears.
describe('cursor create-chat call sites', () => {
  it('are all routed through the bounded helper', () => {
    const offenders = walk(SERVER_ROOT)
      .filter((f) => path.basename(f) !== OWNER)
      .filter((f) =>
        /\[\s*'create-chat'\s*\]|\[\s*"create-chat"\s*\]/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => path.relative(SERVER_ROOT, f));

    expect(
      offenders,
      `These files exec \`create-chat\` directly instead of calling ` +
        `createCursorChatBounded() from ${OWNER}. An unbounded exec here hangs ` +
        `the caller forever when the Cursor CLI wedges (an expired OAuth token ` +
        `reproduces it).`,
    ).toEqual([]);
  });

  it('the bounded helper is the only module importing child_process for it', () => {
    const owner = readFileSync(path.join(SERVER_ROOT, OWNER), 'utf8');
    expect(owner).toContain("from 'child_process'");
    expect(owner).toMatch(/timeout/);
  });
});

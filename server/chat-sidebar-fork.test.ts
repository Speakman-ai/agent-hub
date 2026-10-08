/**
 * SideBar spawn wiring in handleChat: the first Claude turn forks the parent's
 * CLI conversation, runs in the parent's checkout, and never auto-commits or
 * writes hook config into that checkout. Drives real handleChat turns against
 * a stub CLI script that records argv + cwd (never the real `claude`).
 */
import './test/setup.js';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDb, getStmts } from './db.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { Agent, EnrichedAgent, Project } from './types.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn(() => ({})),
}));

const prefix = `sbf-${randomUUID().slice(0, 8)}`;
let dir: string;
let bin: string;
let parentWorktree: string;
let recordFile: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sidebar-fork-'));
  parentWorktree = path.join(dir, 'parent-wt');
  recordFile = path.join(dir, 'record.txt');
  bin = path.join(dir, 'record.sh');
  writeFileSync(
    bin,
    `#!/bin/sh\ncat > /dev/null 2>&1\npwd > "${recordFile}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${recordFile}"; done\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  mkdirSync(parentWorktree, { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(agentId: string, autoCommitAndPR: ChatHandlerDeps['autoCommitAndPR']) {
  const agent = { id: agentId, name: 'SideBar agent', engine: 'claude-code' } as Agent;
  const project = {
    id: 'proj-sidebar-fork',
    name: 'SideBar fork',
    cwd: '/tmp',
    ahw: '',
    agents: [],
  } as unknown as Project;
  const enriched = {
    id: agentId,
    name: 'SideBar agent',
    engine: 'claude-code',
    projectId: 'proj-sidebar-fork',
    cwd: '/tmp',
    ahw: '',
    workspace: '/tmp',
  } as unknown as EnrichedAgent;
  const deps: ChatHandlerDeps = {
    broadcast: () => {},
    createCursorChat: undefined,
    findAgent: (id) => (id === agentId ? { project, agent } : null),
    getEnrichedAgent: (id) => (id === agentId ? enriched : null),
    activeProcesses: new Map<string, ActiveChatProcess>(),
    autonomousProjects: new Set(),
    getClaudeBin: () => bin,
    getCursorBin: () => bin,
    getGeminiBin: () => bin,
    getCodexBin: () => bin,
    getGrokBin: () => bin,
    uploadsDir: '/tmp',
    resolveSlashSkill: vi.fn(),
    ensureWorktree: vi.fn(async () => '/tmp'),
    drainQueue: vi.fn(),
    autoCommitAndPR,
    tryAutonomousDispatch: vi.fn(),
  };
  return deps;
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('handleChat SideBar fork', () => {
  it('forks the parent CLI session in the parent checkout without auto-commit', async () => {
    const stmts = getStmts();
    const agentId = `${prefix}-agent`;
    const parentId = `${prefix}-parent`;
    const sidebarId = randomUUID();
    stmts.createSession.run(parentId, agentId, 'parent', 'claude-code', 'claude-opus-4-8', 1, 0, 1);
    getDb()
      .prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
      .run(parentWorktree, parentId);
    stmts.createSession.run(
      sidebarId,
      agentId,
      'sidebar',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );
    stmts.updateSessionMode.run('consult', sidebarId);
    stmts.markSessionAsSidebar.run(parentId, 'parent-cli-id', parentId, sidebarId);

    const autoCommit = vi.fn(async () => undefined);
    const deps = makeDeps(agentId, autoCommit);
    const { handleChat } = createChatHandler(deps);
    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId: sidebarId,
      content: 'btw what does this do?',
    });
    await waitFor(() => existsSync(recordFile) && !deps.activeProcesses.has(sidebarId));
    // Let the close handler's post-turn tail settle.
    await new Promise((r) => setTimeout(r, 1500));

    const [cwd, ...argv] = readFileSync(recordFile, 'utf8').trim().split('\n');
    expect(cwd).toBe(parentWorktree);
    const resumeIdx = argv.indexOf('--resume');
    expect(argv.slice(resumeIdx, resumeIdx + 5)).toEqual([
      '--resume',
      'parent-cli-id',
      '--fork-session',
      '--session-id',
      sidebarId,
    ]);
    expect(autoCommit).not.toHaveBeenCalled();
    expect(existsSync(path.join(parentWorktree, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(path.join(parentWorktree, '.claude', 'settings.json'))).toBe(false);
  });

  it('falls back to the transcript seed once when the parent conversation is missing', async () => {
    const stmts = getStmts();
    const agentId = `${prefix}-agent-fb`;
    const parentId = `${prefix}-parent-fb`;
    const sidebarId = randomUUID();
    const forkFrom = randomUUID();
    const wt = path.join(dir, 'parent-wt-fb');
    const spawnDir = path.join(dir, 'spawns-fb');
    mkdirSync(wt, { recursive: true });
    mkdirSync(spawnDir, { recursive: true });
    // Fails any --fork-session spawn the way Claude Code does when the parent
    // JSONL is not under this cwd; otherwise answers. Records each spawn's
    // cwd, argv, and system prompt.
    const failBin = path.join(dir, 'fork-fail.sh');
    writeFileSync(
      failBin,
      [
        '#!/bin/sh',
        'cat > /dev/null 2>&1',
        `n=$(ls "${spawnDir}" | grep -c '^spawn-[0-9]*$')`,
        `f="${spawnDir}/spawn-$n"`,
        'pwd > "$f"',
        `for a in "$@"; do printf '%s\\n' "$a" >> "$f"; done`,
        'prev=""',
        'for a in "$@"; do if [ "$prev" = "--system-prompt-file" ]; then cat "$a" > "$f.prompt"; fi; prev="$a"; done',
        `for a in "$@"; do if [ "$a" = "--fork-session" ]; then echo "No conversation found with session ID: ${forkFrom}" >&2; exit 1; fi; done`,
        `echo '{"type":"system","subtype":"init","session_id":"${sidebarId}"}'`,
        `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"side answer"}]}}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"result":"side answer","session_id":"${sidebarId}"}'`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(failBin, 0o755);

    stmts.createSession.run(parentId, agentId, 'parent', 'claude-code', 'claude-opus-4-8', 1, 0, 1);
    getDb().prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(wt, parentId);
    const addParentMsg = getDb().prepare(
      'INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
    );
    addParentMsg.run(randomUUID(), parentId, 'user', 'PARENT_MARKER refactor the parser');
    addParentMsg.run(randomUUID(), parentId, 'assistant', 'Parser split into passes');
    stmts.createSession.run(
      sidebarId,
      agentId,
      'sidebar',
      'claude-code',
      'claude-opus-4-8',
      0,
      0,
      1,
    );
    stmts.updateSessionMode.run('consult', sidebarId);
    stmts.markSessionAsSidebar.run(parentId, forkFrom, parentId, sidebarId);

    const autoCommit = vi.fn(async () => undefined);
    const deps = makeDeps(agentId, autoCommit);
    deps.getClaudeBin = () => failBin;
    const { handleChat } = createChatHandler(deps);
    await handleChat(null, {
      type: 'chat',
      agentId,
      sessionId: sidebarId,
      content: 'btw why three passes?',
    });

    const spawnFiles = () =>
      readdirSync(spawnDir)
        .filter((f) => /^spawn-\d+$/.test(f))
        .sort();
    const assistantRows = () =>
      getDb()
        .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'")
        .all(sidebarId) as Array<{ content: string }>;
    await waitFor(
      () =>
        spawnFiles().length >= 2 &&
        !deps.activeProcesses.has(sidebarId) &&
        assistantRows().some((r) => r.content.includes('side answer')),
      15_000,
    );
    await new Promise((r) => setTimeout(r, 1500));

    // Exactly one retry.
    expect(spawnFiles()).toEqual(['spawn-0', 'spawn-1']);
    const first = readFileSync(path.join(spawnDir, 'spawn-0'), 'utf8');
    const retry = readFileSync(path.join(spawnDir, 'spawn-1'), 'utf8');
    expect(first).toContain('--fork-session');
    expect(first).toContain(forkFrom);
    // The retry drops the fork, starts its own CLI session, and carries the
    // parent transcript as a seed instead.
    expect(retry).not.toContain('--fork-session');
    expect(retry).not.toContain(forkFrom);
    expect(retry.split('\n')).toContain('--session-id');
    expect(retry.split('\n')[0]).toBe(wt);
    // The question rides the retry once, not again as replayed history.
    expect(retry.split('btw why three passes?')).toHaveLength(2);
    const retryPrompt = readFileSync(path.join(spawnDir, 'spawn-1.prompt'), 'utf8');
    expect(retryPrompt).toContain('## SideBar context');
    expect(retryPrompt).toContain('PARENT_MARKER');
    const row = stmts.getSession.get(sidebarId) as {
      fork_from_engine_session_id: string | null;
      pending_skill_context: string | null;
    };
    expect(row.fork_from_engine_session_id).toBeNull();
    expect(row.pending_skill_context).toBeNull();

    // The question is stored once and answered.
    const userRows = getDb()
      .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user'")
      .all(sidebarId) as Array<{ content: string }>;
    expect(userRows.map((r) => r.content)).toEqual(['btw why three passes?']);
    expect(assistantRows().filter((r) => r.content.includes('side answer'))).toHaveLength(1);

    // Still a SideBar turn: no auto-commit, no hook config in the parent tree.
    expect(autoCommit).not.toHaveBeenCalled();
    expect(existsSync(path.join(wt, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(path.join(wt, '.claude', 'settings.json'))).toBe(false);
  });

  it('the generic no-conversation retry stores and sends the question once', async () => {
    const stmts = getStmts();
    const agentId = `${prefix}-agent-nc`;
    const sessionId = randomUUID();
    const staleCli = randomUUID();
    const spawnDir = path.join(dir, 'spawns-nc');
    mkdirSync(spawnDir, { recursive: true });
    const ncBin = path.join(dir, 'resume-fail.sh');
    writeFileSync(
      ncBin,
      [
        '#!/bin/sh',
        'cat > /dev/null 2>&1',
        `n=$(ls "${spawnDir}" | grep -c '^spawn-[0-9]*$')`,
        `f="${spawnDir}/spawn-$n"`,
        `for a in "$@"; do printf '%s\\n' "$a" >> "$f"; done`,
        `for a in "$@"; do if [ "$a" = "${staleCli}" ]; then echo "No conversation found with session ID: ${staleCli}" >&2; exit 1; fi; done`,
        `echo '{"type":"system","subtype":"init","session_id":"${sessionId}"}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"${sessionId}"}'`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(ncBin, 0o755);
    stmts.createSession.run(sessionId, agentId, 'plain', 'claude-code', 'claude-opus-4-8', 0, 0, 1);
    stmts.updateSessionEngineSessionId.run(staleCli, sessionId);

    const deps = makeDeps(
      agentId,
      vi.fn(async () => undefined),
    );
    deps.getClaudeBin = () => ncBin;
    const { handleChat } = createChatHandler(deps);
    await handleChat(null, { type: 'chat', agentId, sessionId, content: 'only once please' });
    const spawns = () => readdirSync(spawnDir).filter((f) => /^spawn-\d+$/.test(f));
    await waitFor(() => spawns().length >= 2 && !deps.activeProcesses.has(sessionId), 15_000);
    await new Promise((r) => setTimeout(r, 1000));

    expect(spawns()).toHaveLength(2);
    const userRows = getDb()
      .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user'")
      .all(sessionId) as Array<{ content: string }>;
    expect(userRows.map((r) => r.content)).toEqual(['only once please']);
    const retry = readFileSync(path.join(spawnDir, 'spawn-1'), 'utf8');
    expect(retry.split('only once please')).toHaveLength(2);
  });
});

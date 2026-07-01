import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const skillInvokeMock = vi.hoisted(() => ({
  defaultSkillsDir: '/tmp/skill-invoke-default',
  globalSkillsDir: '/tmp/skill-invoke-global',
}));

vi.mock('./routes/skills.js', () => ({
  get DEFAULT_SKILLS_DIR() {
    return skillInvokeMock.defaultSkillsDir;
  },
}));

vi.mock('./global-skills-dir.js', () => ({
  resolveGlobalSkillsDir() {
    return skillInvokeMock.globalSkillsDir;
  },
}));

import {
  detectSkillBlock,
  parseSkillBlock,
  loadSkillBody,
  buildSkillInjection,
  handleSkillInvoke,
  resolveSkillDirUnderBase,
} from './skill-invoke.js';

function makeSkill(
  baseDir: string,
  name: string,
  opts?: { refSize?: number; scriptExecutable?: boolean },
) {
  const skillDir = path.join(baseDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\n\nSkill body for ${name}.\n`);

  const refsDir = path.join(skillDir, 'references');
  mkdirSync(refsDir, { recursive: true });
  if (opts?.refSize && opts.refSize > 0) {
    writeFileSync(path.join(refsDir, 'large.txt'), 'x'.repeat(opts.refSize));
  } else {
    writeFileSync(path.join(refsDir, 'about.md'), `reference for ${name}`);
  }

  const scriptsDir = path.join(skillDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, 'run.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\n');
  if (opts?.scriptExecutable) {
    chmodSync(scriptPath, 0o755);
  }

  return skillDir;
}

describe('skill-invoke', () => {
  let tmpRoot: string;
  let projectSkillsDir: string;
  let globalSkillsDir: string;
  let defaultSkillsDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'skill-invoke-'));
    projectSkillsDir = path.join(tmpRoot, 'project-skills');
    globalSkillsDir = path.join(tmpRoot, 'global-skills');
    defaultSkillsDir = path.join(tmpRoot, 'default-skills');
    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(globalSkillsDir, { recursive: true });
    mkdirSync(defaultSkillsDir, { recursive: true });
    skillInvokeMock.defaultSkillsDir = defaultSkillsDir;
    skillInvokeMock.globalSkillsDir = globalSkillsDir;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('detectSkillBlock', () => {
    it('matches valid block and returns null when absent', () => {
      expect(detectSkillBlock('hello')).toBeNull();
      expect(detectSkillBlock('<agenthub:skill>{"name":"kanban"}</agenthub:skill>')).toContain(
        'kanban',
      );
    });

    it('returns the last block when multiple are present', () => {
      const text = [
        '<agenthub:skill>{"name":"first"}</agenthub:skill>',
        '<agenthub:skill>{"name":"second"}</agenthub:skill>',
      ].join('\n');
      const block = detectSkillBlock(text);
      expect(block).toContain('second');
      expect(block).not.toContain('first"}</agenthub:skill>');
    });
  });

  describe('parseSkillBlock', () => {
    it('returns malformed for bad json / missing name / non-string name', () => {
      expect(parseSkillBlock('<agenthub:skill>{oops}</agenthub:skill>')).toMatchObject({
        error: 'malformed',
      });
      expect(parseSkillBlock('<agenthub:skill>{"reason":"x"}</agenthub:skill>')).toMatchObject({
        error: 'malformed',
      });
      expect(parseSkillBlock('<agenthub:skill>{"name":123}</agenthub:skill>')).toMatchObject({
        error: 'malformed',
      });
    });

    // ─── Robustness: action-block parser shape variants ────────────────
    // Regression coverage for the "action blocks sometimes only print"
    // bug. Each of these used to return malformed/invalid-JSON and the
    // skill never loaded.

    it('tolerates a ```json ... ``` fence wrapping the JSON inside the tag', () => {
      const text =
        '<agenthub:skill>\n```json\n{"name":"kanban","reason":"need card ops"}\n```\n</agenthub:skill>';
      expect(parseSkillBlock(text)).toEqual({ name: 'kanban', reason: 'need card ops' });
    });

    it('tolerates lead-in prose before the JSON object', () => {
      const text = '<agenthub:skill>\nLoading skill:\n{"name":"kanban"}\n</agenthub:skill>';
      expect(parseSkillBlock(text)).toEqual({ name: 'kanban' });
    });

    it('tolerates raw newlines inside the reason string', () => {
      const text =
        '<agenthub:skill>{"name":"kanban","reason":"need it because\nof these card ops"}</agenthub:skill>';
      const result = parseSkillBlock(text);
      expect(result).toEqual({
        name: 'kanban',
        reason: 'need it because\nof these card ops',
      });
    });
  });

  describe('loadSkillBody', () => {
    it('prefers project skill over default when both exist', () => {
      const p = makeSkill(projectSkillsDir, 'kanban');
      makeSkill(defaultSkillsDir, 'kanban');

      const loaded = loadSkillBody('kanban', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      expect(loaded?.source).toBe('project');
      expect(loaded?.skillDir).toBe(p);
    });

    it('loads a global-tier skill (source=global) when no project skill exists', () => {
      const g = makeSkill(globalSkillsDir, 'shared-skill');
      const loaded = loadSkillBody('shared-skill', { skillsDir: projectSkillsDir });
      expect(loaded?.source).toBe('global');
      expect(loaded?.skillDir).toBe(g);
    });

    it('precedence: project shadows global shadows default for the same id', () => {
      const p = makeSkill(projectSkillsDir, 'tiered');
      makeSkill(globalSkillsDir, 'tiered');
      makeSkill(defaultSkillsDir, 'tiered');
      const loaded = loadSkillBody('tiered', { skillsDir: projectSkillsDir });
      expect(loaded?.source).toBe('project');
      expect(loaded?.skillDir).toBe(p);
    });

    it('global shadows default when no project skill exists', () => {
      const g = makeSkill(globalSkillsDir, 'g-over-d');
      makeSkill(defaultSkillsDir, 'g-over-d');
      const loaded = loadSkillBody('g-over-d', { skillsDir: projectSkillsDir });
      expect(loaded?.source).toBe('global');
      expect(loaded?.skillDir).toBe(g);
    });

    it('loads a flat skills/<id>.md file', () => {
      writeFileSync(path.join(projectSkillsDir, 'linear.md'), '# Linear\n\nFlat body.\n');
      const loaded = loadSkillBody('linear', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      expect(loaded?.source).toBe('project');
      expect(loaded?.skillTitle).toBe('linear');
      expect(loaded?.references).toEqual([]);
      expect(loaded?.scriptListing).toEqual([]);
      expect(loaded?.skillMd).toContain('Flat body.');
      expect(buildSkillInjection(loaded!)).toContain('## Loaded Skill: linear');
    });

    it('prefers directory skill over co-located flat .md', () => {
      writeFileSync(path.join(projectSkillsDir, 'dup.md'), '# flat\n');
      makeSkill(projectSkillsDir, 'dup');
      const loaded = loadSkillBody('dup', { skillsDir: projectSkillsDir });
      expect(loaded?.skillMd).toContain('Skill body for dup');
      expect(loaded?.skillTitle).toBeUndefined();
    });

    it('returns null when skill is missing', () => {
      const loaded = loadSkillBody('missing', { skillsDir: projectSkillsDir });
      expect(loaded).toBeNull();
    });

    it('rejects path-traversal names and does not read SKILL.md outside the skills dir', () => {
      const outside = path.join(tmpRoot, 'outside-skill');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'SKILL.md'), '# leaked\n\nsecret');

      expect(resolveSkillDirUnderBase(projectSkillsDir, '../outside-skill')).toBeNull();
      expect(loadSkillBody('../outside-skill', { skillsDir: projectSkillsDir })).toBeNull();
      expect(loadSkillBody('foo/bar', { skillsDir: projectSkillsDir })).toBeNull();
    });

    it('rejects a skill directory that is a symlink pointing outside the skills root', () => {
      const outside = path.join(tmpRoot, 'outside-skill-dir');
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, 'SKILL.md'), '# symlinked\n');
      symlinkSync(outside, path.join(projectSkillsDir, 'leak-skill'), 'dir');

      expect(loadSkillBody('leak-skill', { skillsDir: projectSkillsDir })).toBeNull();
    });

    it('does not follow symlinked reference files to read out-of-tree content', () => {
      const skillDir = path.join(projectSkillsDir, 'ref-symlink');
      mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), '# ok\n');
      const secret = path.join(tmpRoot, 'SECRET_REF.txt');
      writeFileSync(secret, 'TOPSECRET_REF_SYMLINK');
      symlinkSync(secret, path.join(skillDir, 'references', 'via-link.md'));

      const loaded = loadSkillBody('ref-symlink', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      const joined = loaded!.references.map((r) => r.body).join('\n');
      expect(joined).not.toContain('TOPSECRET_REF_SYMLINK');
    });

    it('omits symlink entries from scripts listing', () => {
      const skillDir = path.join(projectSkillsDir, 'script-symlink');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), '# ok\n');
      const scriptsDir = path.join(skillDir, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const realScript = path.join(scriptsDir, 'run.sh');
      writeFileSync(realScript, '#!/usr/bin/env bash\necho ok\n');
      const outside = path.join(tmpRoot, 'outside-script.sh');
      writeFileSync(outside, '#!/usr/bin/env bash\necho leak\n');
      symlinkSync(outside, path.join(scriptsDir, 'via-link.sh'));

      const loaded = loadSkillBody('script-symlink', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      expect(loaded!.scriptListing.some((s) => s.startsWith('via-link'))).toBe(false);
      expect(loaded!.scriptListing.some((s) => s.startsWith('run.sh'))).toBe(true);
    });

    it('truncates an oversized SKILL.md body', () => {
      const skillDir = path.join(projectSkillsDir, 'huge-md');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), 'Z'.repeat(40 * 1024));

      const loaded = loadSkillBody('huge-md', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      expect(loaded!.skillMd).toContain('[Truncated: SKILL.md byte cap reached]');
      expect(Buffer.byteLength(loaded!.skillMd, 'utf-8')).toBeLessThanOrEqual(32 * 1024 + 200);
    });

    it('truncates oversize reference files and enforces total cap', () => {
      const skillDir = path.join(projectSkillsDir, 'big');
      mkdirSync(path.join(skillDir, 'references'), { recursive: true });
      writeFileSync(path.join(skillDir, 'SKILL.md'), '# big\n');
      // 4 files * 12KB -> total > 32KB; each file also >8KB.
      for (let i = 0; i < 4; i++) {
        writeFileSync(path.join(skillDir, 'references', `f${i}.txt`), 'a'.repeat(12 * 1024));
      }

      const loaded = loadSkillBody('big', { skillsDir: projectSkillsDir });
      expect(loaded).not.toBeNull();
      expect(loaded!.references.length).toBeGreaterThan(0);
      const total = loaded!.references.reduce(
        (sum, r) => sum + Buffer.byteLength(r.body, 'utf-8'),
        0,
      );
      expect(total).toBeLessThanOrEqual(32 * 1024 + 1000);
      expect(loaded!.references.some((r) => r.body.includes('Truncated'))).toBe(true);
    });
  });

  it('buildSkillInjection includes SKILL.md body and reference sections', () => {
    makeSkill(projectSkillsDir, 'wiki-search');
    const loaded = loadSkillBody('wiki-search', { skillsDir: projectSkillsDir });
    const out = buildSkillInjection(loaded!);
    expect(out).toContain('## Loaded Skill: wiki-search');
    expect(out).toContain('Skill body for wiki-search');
    expect(out).toContain('### Self-improvement');
    expect(out).toContain('<agenthub:skill-improvement>');
    expect(out).toContain('"name":"wiki-search"');
    expect(out).toContain('### References');
    expect(out).toContain('### Available scripts');
  });

  it('buildSkillInjection does NOT inline reference bodies (lazy loading)', () => {
    // Reference body is "reference for lazy-skill" — must appear in
    // loaded.references[*].body but NEVER in the injection text.
    makeSkill(projectSkillsDir, 'lazy-skill');
    const loaded = loadSkillBody('lazy-skill', { skillsDir: projectSkillsDir });
    expect(loaded).not.toBeNull();

    // Body still populated in the loaded struct (for non-prompt callers).
    expect(loaded!.references[0]?.body).toContain('reference for lazy-skill');

    const out = buildSkillInjection(loaded!);

    // Body must NOT be inlined.
    expect(out).not.toContain('reference for lazy-skill');
    // Old fenced code-block wrapper format must be gone too.
    expect(out).not.toContain('#### references/about.md');
    expect(out).not.toMatch(/```text\n[\s\S]*reference for lazy-skill[\s\S]*```/);

    // But the reference must still be discoverable: filename + absolute path
    // the agent can pass to Read.
    expect(out).toMatch(/- references\/about\.md/);
    const absPath = path.join(projectSkillsDir, 'lazy-skill', 'references', 'about.md');
    expect(out).toContain(absPath);
  });

  it('buildSkillInjection shows (none) for skills without references', () => {
    // Flat skill — no references/ directory, references[] is empty.
    writeFileSync(path.join(projectSkillsDir, 'flat-no-refs.md'), '# flat\n\nbody\n');
    const loaded = loadSkillBody('flat-no-refs', { skillsDir: projectSkillsDir });
    const out = buildSkillInjection(loaded!);
    // Section heading still present, with (none) marker.
    expect(out).toMatch(/### References\n\(none\)/);
  });

  it('buildSkillInjection injection stays small even when references are huge', () => {
    // Build a skill with refs that fill the per-file + total caps. Before
    // the lazy-loading change, this would produce a ~32KB injection. After,
    // it should be well under 4KB because only the index is emitted.
    const skillDir = path.join(projectSkillsDir, 'jumbo');
    mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# jumbo\n');
    for (let i = 0; i < 6; i++) {
      writeFileSync(path.join(skillDir, 'references', `f${i}.md`), 'X'.repeat(8 * 1024));
    }
    const loaded = loadSkillBody('jumbo', { skillsDir: projectSkillsDir });
    const injection = buildSkillInjection(loaded!);
    expect(Buffer.byteLength(injection, 'utf-8')).toBeLessThan(4 * 1024);
    // None of the reference bodies should leak in.
    expect(injection).not.toContain('XXXXXXXX');
  });

  it('handleSkillInvoke records loaded/not-found/malformed statuses', () => {
    makeSkill(projectSkillsDir, 'ok-skill');

    const rows: unknown[][] = [];
    const broadcasts: Record<string, unknown>[] = [];
    const stmts = {
      insertSkillInvocation: { run: (...args: unknown[]) => rows.push(args) },
    } as unknown as import('./types.js').Stmts;

    const loaded = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{"name":"ok-skill"}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
    });
    const missing = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{"name":"missing"}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
    });
    const malformed = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{bad}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
    });

    expect(loaded).toContain('## Loaded Skill');
    expect(missing).toContain('Skill Load Error');
    expect(malformed).toContain('Malformed <agenthub:skill> block');

    const statuses = rows.map((r) => r[5]);
    expect(statuses).toContain('loaded');
    expect(statuses).toContain('not-found');
    expect(statuses).toContain('malformed');
  });

  it('enforces the per-agent skill allowlist on the trigger', () => {
    makeSkill(projectSkillsDir, 'ok-skill');
    makeSkill(projectSkillsDir, 'secret-skill');

    const rows: unknown[][] = [];
    const broadcasts: Record<string, unknown>[] = [];
    const stmts = {
      insertSkillInvocation: { run: (...args: unknown[]) => rows.push(args) },
    } as unknown as import('./types.js').Stmts;

    // Allowed skill loads normally.
    const allowed = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{"name":"ok-skill"}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
      allowedSkills: ['ok-skill'],
    });

    // Skill outside the allowlist is blocked with a clear error, never touching disk.
    const blocked = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{"name":"secret-skill"}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
      allowedSkills: ['ok-skill'],
    });

    // Unrestricted agent (no allowlist) can still load anything.
    const unrestricted = handleSkillInvoke({
      rawBlock: '<agenthub:skill>{"name":"secret-skill"}</agenthub:skill>',
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's1',
      stmts,
      broadcast: (e) => broadcasts.push(e as Record<string, unknown>),
      allowedSkills: null,
    });

    expect(allowed).toContain('## Loaded Skill');
    expect(blocked).toContain('Skill Load Error');
    expect(blocked).toContain("not in this agent's allowed-skills list");
    expect(unrestricted).toContain('## Loaded Skill');

    // The blocked attempt is audited (status not-found, the only non-loaded
    // status the CHECK constraint allows).
    const blockedRow = rows.find((r) => r[2] === 'secret-skill' && r[5] === 'not-found');
    expect(blockedRow).toBeTruthy();
  });

  it('integration-style: close-handler flow stashes injection for next turn and then consumes it', () => {
    makeSkill(projectSkillsDir, 'kanban');

    const sessionState: { pending: string | null } = { pending: null };
    const stmts = {
      insertSkillInvocation: { run: () => {} },
      getSession: {
        get: () => ({ pending_skill_context: sessionState.pending }),
      },
      updateSessionPendingSkillContext: {
        run: (value: string | null) => {
          sessionState.pending = value;
        },
      },
    } as unknown as import('./types.js').Stmts;

    const finalContent = [
      'done implementing',
      '<agenthub:skill>{"name":"kanban","reason":"need board API"}</agenthub:skill>',
    ].join('\n');

    const raw = detectSkillBlock(finalContent);
    expect(raw).not.toBeNull();

    const injection = handleSkillInvoke({
      rawBlock: raw!,
      paths: { skillsDir: projectSkillsDir },
      sessionId: 's2',
      stmts,
      broadcast: () => {},
    });

    const existing = (stmts.getSession.get('s2') as { pending_skill_context: string | null })
      .pending_skill_context;
    stmts.updateSessionPendingSkillContext.run(
      existing ? `${existing}\n\n${injection}` : injection,
      's2',
    );

    expect(sessionState.pending).toContain('## Loaded Skill: kanban');

    // Next turn prompt build consumes + clears.
    let enrichedPrompt = 'base system prompt';
    const pending = sessionState.pending?.trim() || '';
    if (pending) {
      enrichedPrompt += `\n\n${pending}`;
      stmts.updateSessionPendingSkillContext.run(null, 's2');
    }

    expect(enrichedPrompt).toContain('## Loaded Skill: kanban');
    expect(sessionState.pending).toBeNull();
  });
});

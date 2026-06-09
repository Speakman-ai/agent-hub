import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCiConfig, loadCiConfigFromFile } from './ci-config.js';
import type { CiConfigV2 } from './ci-config.js';
import {
  canonicalCommands,
  computeWorkflowDrift,
  formatDriftReport,
  loadGithubWorkflows,
  loadMirrorManifest,
  parseGithubWorkflow,
  parseMirrorManifest,
  parseMirrorRef,
  type GithubWorkflow,
  type WorkflowMirrorManifest,
} from './workflow-drift.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a v2 ci.yaml config from a YAML string, asserting it parsed cleanly. */
function v2(yaml: string): CiConfigV2 {
  const parsed = parseCiConfig(yaml);
  if (!parsed.ok) throw new Error(`fixture ci.yaml failed to parse: ${parsed.error.message}`);
  if (parsed.config.version !== 2) throw new Error('fixture is not v2');
  return parsed.config;
}

function manifest(over: Partial<WorkflowMirrorManifest> = {}): WorkflowMirrorManifest {
  return { workflows: ['ci.yml'], ignore: [], jobs: { build: 'ci.yml:build' }, ...over };
}

/** A ci.yaml with a single build job. The mirror mapping lives in the manifest. */
const BASE_CI = `
version: 2
on: [finalize]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - name: Build
        run: npm run build
      - name: Typecheck
        run: cd server && npx tsc --noEmit
`;

/** A GitHub workflow whose `build` job matches BASE_CI's build job commands. */
function ghBuild(
  runScripts: string[] = ['npm run build', 'cd server && npx tsc --noEmit'],
): GithubWorkflow {
  return { filename: 'ci.yml', jobs: [{ jobId: 'build', runScripts }] };
}

describe('canonicalCommands', () => {
  it('drops blank lines, comments, scaffolding, and install commands', () => {
    const cmds = canonicalCommands([
      `# comment\n\nfor attempt in 1 2 3; do\n  npm ci --include=dev && exit 0\n  echo "retry"\n  sleep 5\ndone\nexit 1`,
      `npm run build`,
    ]);
    expect([...cmds]).toEqual(['npm run build']);
  });

  it('peels subshell parens and strips trailing && exit 0', () => {
    const cmds = canonicalCommands(['(cd client && npm run lint) && exit 0']);
    expect([...cmds]).toEqual(['cd client && npm run lint']);
  });

  it('drops GHA ${{ }} context-expression lines', () => {
    const cmds = canonicalCommands(['echo ${{ github.sha }}\nnpm run build']);
    expect([...cmds]).toEqual(['npm run build']);
  });

  it('collapses internal whitespace', () => {
    const cmds = canonicalCommands(['npm    run     build']);
    expect([...cmds]).toEqual(['npm run build']);
  });

  it('treats install commands as scaffolding even with a cd prefix', () => {
    const cmds = canonicalCommands([
      'cd server && npm ci --include=dev',
      'npm rebuild better-sqlite3',
    ]);
    expect([...cmds]).toEqual([]);
  });
});

describe('parseMirrorRef', () => {
  it('parses finalize-only', () => {
    expect(parseMirrorRef('finalize-only')).toEqual({ kind: 'finalize-only' });
  });
  it('parses a github ref', () => {
    expect(parseMirrorRef('ci.yml:build')).toEqual({
      kind: 'github',
      githubRef: 'ci.yml:build',
      loose: false,
    });
  });
  it('parses a loose github ref', () => {
    expect(parseMirrorRef('main-checks.yml:lint (loose)')).toEqual({
      kind: 'github',
      githubRef: 'main-checks.yml:lint',
      loose: true,
    });
  });
  it('rejects garbage', () => {
    expect(parseMirrorRef('not a ref').kind).toBe('invalid');
    expect(parseMirrorRef('ci.yml').kind).toBe('invalid');
  });
});

describe('parseMirrorManifest', () => {
  it('parses workflows, ignore, and the jobs map', () => {
    const r = parseMirrorManifest(`
workflows: [ci.yml, main-checks.yml]
ignore: [ci.yml:ci]
jobs:
  build: ci.yml:build
  test: finalize-only
  lint: main-checks.yml:lint (loose)
`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.manifest).toEqual({
      workflows: ['ci.yml', 'main-checks.yml'],
      ignore: ['ci.yml:ci'],
      jobs: { build: 'ci.yml:build', test: 'finalize-only', lint: 'main-checks.yml:lint (loose)' },
    });
  });

  it('defaults workflows/ignore to [] when omitted', () => {
    const r = parseMirrorManifest('jobs:\n  build: ci.yml:build');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.manifest.workflows).toEqual([]);
    expect(r.manifest.ignore).toEqual([]);
  });

  it('requires a jobs mapping', () => {
    const r = parseMirrorManifest('workflows: [ci.yml]');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/jobs/);
  });

  it('rejects unknown top-level keys', () => {
    const r = parseMirrorManifest('jobs: {}\nbogus: 1');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/unknown key 'bogus'/);
  });

  it('rejects a non-string jobs value', () => {
    const r = parseMirrorManifest('jobs:\n  build: 5');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/jobs\.build/);
  });

  it('rejects non-YAML / non-mapping', () => {
    expect(parseMirrorManifest('- a\n- b').ok).toBe(false);
  });
});

describe('parseGithubWorkflow', () => {
  it('extracts jobs, names, runs-on, and per-step run scripts', () => {
    const wf = parseGithubWorkflow(
      `name: CI
jobs:
  build:
    name: Build & typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: npm run build
      - name: Typecheck
        run: cd server && npx tsc --noEmit
`,
      'ci.yml',
    );
    expect(wf.name).toBe('CI');
    expect(wf.jobs).toHaveLength(1);
    expect(wf.jobs[0]).toMatchObject({
      jobId: 'build',
      name: 'Build & typecheck',
      runsOn: 'ubuntu-latest',
      runScripts: ['npm run build', 'cd server && npx tsc --noEmit'],
    });
  });

  it('records a parseError for malformed YAML rather than throwing', () => {
    const wf = parseGithubWorkflow(': : not yaml : :', 'broken.yml');
    expect(wf.jobs).toEqual([]);
    expect(wf.parseError).toBeTruthy();
  });

  it('records a parseError when the root is not a mapping', () => {
    const wf = parseGithubWorkflow('- a\n- b', 'list.yml');
    expect(wf.jobs).toEqual([]);
    expect(wf.parseError).toMatch(/not a mapping/);
  });

  it('an empty / comment-only file is NOT a parse error', () => {
    expect(parseGithubWorkflow('# just a comment\n', 'empty.yml')).toEqual({
      filename: 'empty.yml',
      jobs: [],
    });
  });
});

describe('computeWorkflowDrift', () => {
  it('no-ops when there is no mirror manifest', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: null,
      workflows: [ghBuild()],
    });
    expect(report.notConfigured).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.hasBlockingDrift).toBe(false);
  });

  it('MATCH: mapped job with identical commands → no drift', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest(),
      workflows: [ghBuild()],
    });
    expect(report.hasBlockingDrift).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.matches).toEqual([
      { ciJob: 'build', githubRef: 'ci.yml:build', comparedCommands: true },
    ]);
  });

  it('ADDED: a new GitHub job not mapped or ignored → blocking unmapped_github_job', () => {
    const workflows: GithubWorkflow[] = [
      {
        filename: 'ci.yml',
        jobs: [
          { jobId: 'build', runScripts: ['npm run build', 'cd server && npx tsc --noEmit'] },
          { jobId: 'newjob', runScripts: ['npm run something'] },
        ],
      },
    ];
    const report = computeWorkflowDrift({ ciConfig: v2(BASE_CI), manifest: manifest(), workflows });
    expect(report.hasBlockingDrift).toBe(true);
    const f = report.findings.find((x) => x.kind === 'unmapped_github_job');
    expect(f).toBeDefined();
    expect(f!.ref).toBe('ci.yml:newjob');
    expect(f!.severity).toBe('error');
  });

  it('REMOVED: a mirror ref pointing at a vanished GitHub job → blocking stale_mirror_target', () => {
    const workflows: GithubWorkflow[] = [
      { filename: 'ci.yml', jobs: [{ jobId: 'renamed', runScripts: ['npm run build'] }] },
    ];
    const report = computeWorkflowDrift({ ciConfig: v2(BASE_CI), manifest: manifest(), workflows });
    expect(report.hasBlockingDrift).toBe(true);
    const stale = report.findings.find((x) => x.kind === 'stale_mirror_target');
    expect(stale).toBeDefined();
    expect(stale!.ref).toBe('jobs.build');
    expect(
      report.findings.some((x) => x.kind === 'unmapped_github_job' && x.ref === 'ci.yml:renamed'),
    ).toBe(true);
  });

  it('CHANGED: mapped job whose commands diverge → command_drift warning with detail', () => {
    const workflows = [ghBuild(['npm run build:prod', 'cd server && npx tsc --noEmit'])];
    const report = computeWorkflowDrift({ ciConfig: v2(BASE_CI), manifest: manifest(), workflows });
    expect(report.hasBlockingDrift).toBe(false);
    expect(report.hasWarnings).toBe(true);
    const drift = report.findings.find((x) => x.kind === 'command_drift');
    expect(drift).toBeDefined();
    expect(drift!.detail).toEqual({
      onlyInGithub: ['npm run build:prod'],
      onlyInCi: ['npm run build'],
    });
  });

  it('UNANNOTATED: a ci.yaml job not in the manifest → blocking unannotated_ci_job', () => {
    const config = v2(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run build
  orphan:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run orphan
`);
    const report = computeWorkflowDrift({
      ciConfig: config,
      manifest: manifest(),
      workflows: [
        { filename: 'ci.yml', jobs: [{ jobId: 'build', runScripts: ['npm run build'] }] },
      ],
    });
    expect(report.hasBlockingDrift).toBe(true);
    const f = report.findings.find((x) => x.kind === 'unannotated_ci_job');
    expect(f!.ref).toBe('jobs.orphan');
  });

  it('UNKNOWN: a manifest job entry with no matching ci.yaml job → blocking unknown_ci_job', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ jobs: { build: 'ci.yml:build', ghost: 'finalize-only' } }),
      workflows: [ghBuild()],
    });
    expect(report.hasBlockingDrift).toBe(true);
    const f = report.findings.find((x) => x.kind === 'unknown_ci_job');
    expect(f!.ref).toBe('jobs.ghost');
  });

  it('finalize-only jobs need no GitHub counterpart', () => {
    const config = v2(`
version: 2
on: [finalize]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run build
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: npm test
`);
    const report = computeWorkflowDrift({
      ciConfig: config,
      manifest: manifest({ jobs: { build: 'ci.yml:build', test: 'finalize-only' } }),
      workflows: [
        { filename: 'ci.yml', jobs: [{ jobId: 'build', runScripts: ['npm run build'] }] },
      ],
    });
    expect(report.findings).toEqual([]);
    expect(report.hasBlockingDrift).toBe(false);
  });

  it('ignore entries claim a GitHub job so it is not flagged unmapped', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ ignore: ['ci.yml:deploy'] }),
      workflows: [
        {
          filename: 'ci.yml',
          jobs: [
            { jobId: 'build', runScripts: ['npm run build', 'cd server && npx tsc --noEmit'] },
            { jobId: 'deploy', runScripts: ['./deploy.sh'] },
          ],
        },
      ],
    });
    expect(report.hasBlockingDrift).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('stale ignore entry → warning', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ ignore: ['ci.yml:gone'] }),
      workflows: [ghBuild()],
    });
    expect(report.hasBlockingDrift).toBe(false);
    const f = report.findings.find((x) => x.kind === 'stale_ignore');
    expect(f!.ref).toBe('ci.yml:gone');
    expect(f!.severity).toBe('warning');
  });

  it('loose mirror asserts existence but skips command comparison', () => {
    const config = v2(`
version: 2
on: [finalize]
jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: npm run lint
`);
    const report = computeWorkflowDrift({
      ciConfig: config,
      manifest: manifest({ jobs: { lint: 'ci.yml:lint (loose)' } }),
      workflows: [
        {
          filename: 'ci.yml',
          jobs: [{ jobId: 'lint', runScripts: ['npm run lint', 'npm run format:check'] }],
        },
      ],
    });
    expect(report.findings).toEqual([]);
    expect(report.matches[0].comparedCommands).toBe(false);
  });

  it('a declared workflow that produced no jobs (missing/unparseable file) → stale_mirror_target', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ workflows: ['ci.yml', 'gone.yml'] }),
      workflows: [
        { filename: 'ci.yml', jobs: [{ jobId: 'build', runScripts: ['npm run build'] }] },
      ],
    });
    expect(report.hasBlockingDrift).toBe(true);
    expect(
      report.findings.some((f) => f.kind === 'stale_mirror_target' && f.ref === 'gone.yml'),
    ).toBe(true);
  });

  it('bad mirror ref → blocking bad_mirror_ref', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ jobs: { build: 'not-a-valid-ref' } }),
      workflows: [ghBuild()],
    });
    expect(report.hasBlockingDrift).toBe(true);
    expect(report.findings[0].kind).toBe('bad_mirror_ref');
  });

  it('PARSE ERROR: an in-scope unparseable workflow → blocking workflow_parse_error', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest(),
      workflows: [{ filename: 'ci.yml', jobs: [], parseError: 'YAML parse error: boom' }],
    });
    expect(report.hasBlockingDrift).toBe(true);
    const f = report.findings.find((x) => x.kind === 'workflow_parse_error');
    expect(f).toBeDefined();
    expect(f!.ref).toBe('ci.yml');
    expect(f!.severity).toBe('error');
  });

  it("PARSE ERROR: a malformed workflow whose jobs are all 'ignored' still blocks (not just a stale_ignore warning)", () => {
    // Reviewer scenario: the file is in scope and its job is listed under
    // ignore. If parse errors were swallowed it would look like a benign
    // stale_ignore (exit 0) even though GitHub itself would reject the file.
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ ignore: ['ci.yml:deploy'] }),
      workflows: [{ filename: 'ci.yml', jobs: [], parseError: 'YAML parse error: boom' }],
    });
    expect(report.hasBlockingDrift).toBe(true);
    expect(report.findings.some((f) => f.kind === 'workflow_parse_error')).toBe(true);
  });

  it('PARSE ERROR: an OUT-OF-scope unparseable workflow does not block', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest({ workflows: ['ci.yml'] }),
      workflows: [
        ghBuild(),
        { filename: 'deploy.yml', jobs: [], parseError: 'YAML parse error: boom' },
      ],
    });
    expect(report.hasBlockingDrift).toBe(false);
    expect(report.findings.some((f) => f.kind === 'workflow_parse_error')).toBe(false);
  });
});

describe('formatDriftReport', () => {
  it('reports the not-configured case', () => {
    expect(
      formatDriftReport({
        notConfigured: true,
        findings: [],
        matches: [],
        hasBlockingDrift: false,
        hasWarnings: false,
      }),
    ).toMatch(/not configured/);
  });

  it('reports OK with the mirrored-job count', () => {
    const report = computeWorkflowDrift({
      ciConfig: v2(BASE_CI),
      manifest: manifest(),
      workflows: [ghBuild()],
    });
    expect(formatDriftReport(report)).toMatch(/OK — 1 mirrored job/);
  });

  it('lists errors before warnings, sorted by ref', () => {
    const workflows: GithubWorkflow[] = [
      {
        filename: 'ci.yml',
        jobs: [
          { jobId: 'build', runScripts: ['npm run build:prod', 'cd server && npx tsc --noEmit'] },
          { jobId: 'zeta', runScripts: ['x'] },
        ],
      },
    ];
    const report = computeWorkflowDrift({ ciConfig: v2(BASE_CI), manifest: manifest(), workflows });
    const out = formatDriftReport(report);
    expect(out.indexOf('[ERROR]')).toBeLessThan(out.indexOf('[warn '));
  });
});

describe('integration: the real agent-hub repo passes its own drift check', () => {
  it('has no blocking drift against .github/workflows', async () => {
    const parsed = await loadCiConfigFromFile(join(repoRoot, '.agent-hub', 'ci.yaml'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2)
      throw new Error('expected real ci.yaml to be v2');
    const manifestResult = await loadMirrorManifest(join(repoRoot, '.agent-hub', 'ci-mirror.yaml'));
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) throw new Error(manifestResult.error);
    expect(manifestResult.manifest).not.toBeNull();
    const workflows = await loadGithubWorkflows(join(repoRoot, '.github', 'workflows'));
    const report = computeWorkflowDrift({
      ciConfig: parsed.config,
      manifest: manifestResult.manifest,
      workflows,
    });
    expect(report.notConfigured).toBe(false);
    expect(report.hasBlockingDrift).toBe(false);
    expect(report.matches.map((m) => m.ciJob).sort()).toEqual(['build', 'lint']);
  });

  it('loadGithubWorkflows returns [] for a missing directory', async () => {
    expect(await loadGithubWorkflows(join(repoRoot, 'no', 'such', 'dir'))).toEqual([]);
  });

  it('loadMirrorManifest returns manifest:null for a missing file (not configured)', async () => {
    const r = await loadMirrorManifest(join(repoRoot, 'no', 'such', 'ci-mirror.yaml'));
    expect(r).toEqual({ ok: true, manifest: null });
  });
});

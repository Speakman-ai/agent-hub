import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PR_ENVIRONMENTS_SCHEMA } from './pr-environments-schema.js';
import {
  createPrEnvironmentService,
  createPrEnvironmentStore,
  type PrAuthoritativeState,
  type PrEnvironmentReporter,
} from './pr-environments.js';
import type { Project } from '../types.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const project = { id: 'p1' } as Project;
const NATIVE = { source: 'native' as const, prNumber: 7 };
const GITHUB = { source: 'github' as const, prNumber: 9 };

function setup() {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENTS_SCHEMA);
  const reporters: PrEnvironmentReporter[] = [];
  const runtime = {
    build: vi.fn(({ reporter }: { reporter: PrEnvironmentReporter }) => {
      reporters.push(reporter);
    }),
    teardown: vi.fn(),
  };
  const heads = new Map<string, string>([
    ['native#7', SHA_A],
    ['github#9', SHA_A],
  ]);
  const readPrState = vi.fn(
    async (
      _p: Project,
      pr: { source: string; prNumber: number },
    ): Promise<PrAuthoritativeState> => {
      const headSha = heads.get(`${pr.source}#${pr.prNumber}`);
      return headSha ? { status: 'open', headSha, headBranch: 'feature' } : null;
    },
  );
  const probe = vi.fn(async () => 'present' as const);
  let clock = 1_000;
  const service = createPrEnvironmentService({
    store: createPrEnvironmentStore(db),
    probePreviewConfig: probe,
    findProject: (id) => (id === project.id ? project : null),
    broadcast: vi.fn(),
    getRuntime: () => runtime,
    readPrState,
    listOpenPrs: () => [{ projectId: project.id, prNumber: NATIVE.prNumber }],
    listOpenGithubPrs: async () => [
      { projectId: project.id, prNumber: GITHUB.prNumber, headSha: heads.get('github#9')! },
    ],
    now: () => (clock += 1),
    log: () => {},
  });
  return { service, runtime, probe, heads };
}

const openAt = (headSha: string) => async () =>
  ({ status: 'open', headSha, headBranch: 'feature' }) as const;

describe('PR environments are opt-in', () => {
  it('opening a PR or moving its head does not start an environment', async () => {
    const { service, runtime, probe } = setup();
    expect(
      await service.onPrOpened(project, { ...NATIVE, headSha: SHA_A, headBranch: 'feature' }),
    ).toBeNull();
    expect(await service.reconcile(project, NATIVE)).toBeNull();
    expect(service.get(project.id, NATIVE)).toBeNull();
    expect(runtime.build).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('catch-up leaves open native and GitHub PRs without an environment alone', async () => {
    const { service, runtime, probe } = setup();
    await service.catchUp();
    expect(service.get(project.id, NATIVE)).toBeNull();
    expect(service.get(project.id, GITHUB)).toBeNull();
    expect(runtime.build).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('Start creates the environment, and later pushes rebuild it', async () => {
    const { service, runtime, heads } = setup();
    const started = await service.start(project, NATIVE, openAt(SHA_A));
    expect(started).toMatchObject({ ok: true, environment: { status: 'queued', headSha: SHA_A } });
    expect(runtime.build).toHaveBeenCalledTimes(1);

    heads.set('native#7', SHA_B);
    const moved = await service.reconcile(project, NATIVE);
    expect(moved).toMatchObject({ status: 'queued', headSha: SHA_B });
    expect(runtime.build).toHaveBeenCalledTimes(2);
  });

  it('catch-up still moves a started GitHub environment to the new head', async () => {
    const { service, runtime, heads } = setup();
    await service.start(project, GITHUB, openAt(SHA_A));
    heads.set('github#9', SHA_B);
    await service.catchUp();
    expect(service.get(project.id, GITHUB)).toMatchObject({ status: 'queued', headSha: SHA_B });
    expect(runtime.build).toHaveBeenCalledTimes(2);
  });
});

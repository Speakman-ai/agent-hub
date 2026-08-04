import '../test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  maybeDispatchAutofixAfterScan,
  maybeAutofixAfterUnattendedScan,
  resolveSecurityFixAutomation,
  securityAutofixEnabled,
  NO_FIX_AGENT_ERROR,
  type SecurityAutofixDeps,
} from './autofix.js';
import type { SecurityFindingRow } from './findings-store.js';
import type { Project } from '../types.js';

vi.mock('../native-pr/author-user.js', () => ({
  isKnownHubUserId: (id: string | null | undefined) => !!id && id !== 'ghost',
  attributionOptional: () => true,
}));

function row(overrides: Partial<SecurityFindingRow> = {}): SecurityFindingRow {
  return {
    id: 'f1',
    project_id: 'p1',
    ecosystem: 'npm',
    package_name: 'lodash',
    package_version: '4.17.11',
    advisory_id: 'GHSA-a',
    severity: 'high',
    summary: 'Prototype pollution',
    fixed_version: '4.17.21',
    advisory_url: null,
    manifest_path: 'package-lock.json',
    status: 'open',
    first_seen_at: 1,
    last_seen_at: 1,
    scan_ref: 'main',
    last_scan_id: 's1',
    ...overrides,
  } as SecurityFindingRow;
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    gitHost: 'agenthub',
    agents: [{ id: 'lead', name: 'Lead', engine: 'claude-code', role: 'lead' }],
    ...over,
  } as unknown as Project;
}

/** A scan that persisted one new finding — the normal "should dispatch" input. */
const FRESH_SCAN = { dryRun: false, newFindings: 1, reopened: 0 };

let dispatch: ReturnType<typeof vi.fn>;
let listFindings: ReturnType<typeof vi.fn>;

function deps(): SecurityAutofixDeps {
  return {
    stmts: {} as never,
    config: {} as never,
    findAgent: vi.fn() as never,
    handleChat: vi.fn() as never,
    store: { listFindings } as never,
    dispatch: dispatch as never,
  };
}

beforeEach(() => {
  listFindings = vi.fn(() => [row()]);
  dispatch = vi.fn(() => ({
    sessionId: 'sess-1',
    session: {} as never,
    agentId: 'lead',
    findingCount: 1,
    reused: false,
  }));
});

describe('securityAutofixEnabled', () => {
  it('is off unless the project is Hub-hosted AND opted in', () => {
    expect(securityAutofixEnabled(project())).toBe(false);
    expect(securityAutofixEnabled(project({ securityAutoPr: { enabled: true } }))).toBe(true);
    expect(
      securityAutofixEnabled(project({ gitHost: 'github', securityAutoPr: { enabled: true } })),
    ).toBe(false);
  });
});

describe('resolveSecurityFixAutomation', () => {
  it('defaults to push (open a PR for a human)', () => {
    expect(resolveSecurityFixAutomation(project({ securityAutoPr: { enabled: true } }))).toBe(
      'push',
    );
  });

  it('is merge when auto-merge is on with a resolvable actor', () => {
    const p = project({
      securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'user-1' },
    });
    expect(resolveSecurityFixAutomation(p)).toBe('merge');
  });

  it('falls back to push when auto-merge is on but the actor no longer resolves', () => {
    // Fail-safe: never merge unattended with no accountable identity.
    const p = project({ securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'ghost' } });
    expect(resolveSecurityFixAutomation(p)).toBe('push');
  });
});

describe('maybeDispatchAutofixAfterScan', () => {
  it('dispatches at push automation for an opted-in project with fresh findings', () => {
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), { project: p, scan: FRESH_SCAN });
    expect(out.session).toMatchObject({ sessionId: 'sess-1', findingCount: 1, reused: false });
    expect(out.error).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ automation: 'push' }),
    );
  });

  it('dispatches at merge automation when the project opted into auto-merge', () => {
    const p = project({
      securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'user-1' },
    });
    maybeDispatchAutofixAfterScan(deps(), { project: p, scan: FRESH_SCAN });
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ automation: 'merge', ownerUserId: 'user-1' }),
    );
  });

  it('prefers the human who triggered the scan over the configured actor', () => {
    const p = project({
      securityAutoPr: { enabled: true, autoMerge: true, actorUserId: 'user-1' },
    });
    maybeDispatchAutofixAfterScan(deps(), {
      project: p,
      scan: FRESH_SCAN,
      ownerUserId: 'clicker',
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: 'clicker' }),
    );
  });

  it('does nothing when the project has not opted in', () => {
    const out = maybeDispatchAutofixAfterScan(deps(), { project: project(), scan: FRESH_SCAN });
    expect(out).toEqual({ session: null, error: null });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing for a non-hosted project even on an explicit click', () => {
    const p = project({ gitHost: 'github', securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), {
      project: p,
      scan: FRESH_SCAN,
      explicit: true,
    });
    expect(out.session).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does nothing after a dry run — nothing was persisted to act on', () => {
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), {
      project: p,
      scan: { dryRun: true, newFindings: 3, reopened: 0 },
      explicit: true,
    });
    expect(out.session).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips the opt-in when the scan surfaced nothing new (no duplicate sessions)', () => {
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), {
      project: p,
      scan: { dryRun: false, newFindings: 0, reopened: 0 },
    });
    expect(out.session).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still dispatches on an explicit click when nothing is new', () => {
    const out = maybeDispatchAutofixAfterScan(deps(), {
      project: project(),
      scan: { dryRun: false, newFindings: 0, reopened: 0 },
      explicit: true,
    });
    expect(out.session).not.toBeNull();
  });

  it('reports the no-agent problem instead of a silent no-op', () => {
    dispatch = vi.fn(() => null);
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), { project: p, scan: FRESH_SCAN });
    expect(out.session).toBeNull();
    expect(out.error).toBe(NO_FIX_AGENT_ERROR);
  });

  it('is a clean no-op (no error) when nothing is open', () => {
    listFindings = vi.fn(() => []);
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeDispatchAutofixAfterScan(deps(), { project: p, scan: FRESH_SCAN });
    expect(out).toEqual({ session: null, error: null });
  });
});

describe('maybeAutofixAfterUnattendedScan', () => {
  const result = { dryRun: false, summary: { newFindings: [row()], reopenedFindings: [] } };

  it('dispatches and logs for an opted-in project', () => {
    const log = vi.fn();
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeAutofixAfterUnattendedScan({
      project: p,
      result,
      autofix: deps(),
      log,
      tag: 'security-schedule',
    });
    expect(out.session?.sessionId).toBe('sess-1');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dispatched fix session sess-1'));
  });

  it('is a no-op when no autofix collaborators were wired', () => {
    const log = vi.fn();
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeAutofixAfterUnattendedScan({ project: p, result, log, tag: 't' });
    expect(out).toEqual({ session: null, error: null });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('swallows and logs a dispatch failure so the scan path is never broken', () => {
    const log = vi.fn();
    const p = project({ securityAutoPr: { enabled: true } });
    const out = maybeAutofixAfterUnattendedScan({
      project: p,
      result,
      autofix: deps(),
      dispatchAutofix: (() => {
        throw new Error('boom');
      }) as never,
      log,
      tag: 'security-on-push',
    });
    expect(out).toEqual({ session: null, error: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

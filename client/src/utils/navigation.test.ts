import { afterEach, describe, it, expect } from 'vitest';
import {
  DEFAULT_VIEW,
  buildNavigationHash,
  getInitialNavigation,
  getInitialView,
  parseNavigationHash,
  parseNavigationPath,
  readNavigationStateFromLocation,
} from './navigation';

describe('navigation defaults', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('defaults the home view to the dashboard', () => {
    expect(DEFAULT_VIEW!).toBe('dashboard');
  });

  it('lands on the dashboard when nothing is requested', () => {
    expect(getInitialView()).toBe('dashboard');
    expect(getInitialView(undefined)).toBe('dashboard');
    expect(getInitialView('')).toBe('dashboard');
    expect(getInitialView('   ')).toBe('dashboard');
    expect(getInitialView(null)).toBe('dashboard');
  });

  it('honors an explicit requested view', () => {
    expect(getInitialView('chat')).toBe('chat');
    expect(getInitialView('skills')).toBe('skills');
    expect(getInitialView('settings:account')).toBe('settings:account');
  });

  it('reads the initial view from the URL hash when no explicit view is passed', () => {
    window.history.replaceState(null, '', '/#/security/agent-hub');

    expect(getInitialView()).toBe('security');
    expect(getInitialNavigation()).toEqual({
      view: 'security',
      projectId: 'agent-hub',
      prNumber: null,
      threadId: null,
      designId: null,
      ticketId: null,
    });
  });

  it('keeps explicit test hooks ahead of URL navigation', () => {
    window.history.replaceState(null, '', '/#/support/agent-hub');

    expect(getInitialView('chat')).toBe('chat');
    expect(getInitialNavigation('chat')).toEqual({ view: 'chat' });
  });

  it('round-trips project-scoped routes with detail params', () => {
    const hash = buildNavigationHash({
      view: 'pulls',
      projectId: 'agent-hub',
      prNumber: 313,
    });

    expect(hash).toBe('#/pulls/agent-hub?pr=313');
    expect(parseNavigationHash(hash)).toEqual({
      view: 'pulls',
      projectId: 'agent-hub',
      prNumber: 313,
      threadId: null,
      designId: null,
      ticketId: null,
    });
  });

  it('round-trips a support route with a deep-linked ticket id', () => {
    const hash = buildNavigationHash({
      view: 'support',
      projectId: 'agent-hub',
      ticketId: 'ticket-42',
    });

    expect(hash).toBe('#/support/agent-hub?ticket=ticket-42');
    expect(parseNavigationHash(hash)).toEqual({
      view: 'support',
      projectId: 'agent-hub',
      prNumber: null,
      threadId: null,
      designId: null,
      ticketId: 'ticket-42',
    });
  });

  it('omits the ticket param for a support route without a ticket', () => {
    expect(buildNavigationHash({ view: 'support', projectId: 'agent-hub' })).toBe(
      '#/support/agent-hub',
    );
  });

  it('does not emit a ticket param for non-support views', () => {
    expect(
      buildNavigationHash({ view: 'deployments', projectId: 'agent-hub', ticketId: 'ticket-1' }),
    ).toBe('#/deployments/agent-hub');
  });

  it('treats calendar as a GLOBAL view, not a project-scoped one', () => {
    // Regression (card 1287): Calendar moved from a per-project tab to the
    // global Dashboard tier. It must build a bare `#/calendar` hash and never
    // carry a projectId segment, even if one is passed.
    expect(buildNavigationHash({ view: 'calendar' })).toBe('#/calendar');
    expect(buildNavigationHash({ view: 'calendar', projectId: 'agent-hub' })).toBe('#/calendar');

    expect(parseNavigationHash('#/calendar')).toEqual({
      view: 'calendar',
      projectId: null,
      prNumber: null,
      threadId: null,
      designId: null,
      ticketId: null,
    });
  });

  it('does not parse a trailing segment after calendar as a projectId', () => {
    // A stale `#/calendar/agent-hub` deep link (pre-migration) must resolve to
    // the global calendar view with no project — the second segment is ignored.
    expect(parseNavigationHash('#/calendar/agent-hub')?.projectId).toBeNull();
    expect(parseNavigationHash('#/calendar/agent-hub')?.view).toBe('calendar');
  });

  it('maps stale Sheets and Drive page links back to Dashboard', () => {
    expect(parseNavigationHash('#/sheets/agent-hub')).toEqual({
      view: 'dashboard',
      projectId: null,
      prNumber: null,
      threadId: null,
      designId: null,
      ticketId: null,
    });
    expect(parseNavigationHash('#/drive')).toMatchObject({ view: 'dashboard', projectId: null });
  });

  it('round-trips currentView strings that already carry their own target', () => {
    const hash = buildNavigationHash({ view: 'kanban:agent-hub' });

    expect(hash).toBe('#/kanban%3Aagent-hub');
    expect(parseNavigationHash(hash)?.view).toBe('kanban:agent-hub');
  });
});

describe('path deep links', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('resolves /projects/<id>/pulls/<number> to the PR detail route', () => {
    expect(parseNavigationPath('/projects/surveytracker/pulls/306')).toEqual({
      state: { view: 'pulls', projectId: 'surveytracker', prNumber: 306 },
      basePath: '',
    });
  });

  it('resolves a project-scoped path with no detail segment', () => {
    expect(parseNavigationPath('/projects/agent-hub/wiki')?.state).toEqual({
      view: 'wiki',
      projectId: 'agent-hub',
      prNumber: null,
    });
  });

  it('keeps a deployment path prefix as the basePath', () => {
    expect(parseNavigationPath('/hub/projects/agent-hub/pulls/12')).toEqual({
      state: { view: 'pulls', projectId: 'agent-hub', prNumber: 12 },
      basePath: '/hub',
    });
  });

  it('ignores paths that are not project-scoped view deep links', () => {
    expect(parseNavigationPath('/')).toBeNull();
    expect(parseNavigationPath('/projects/agent-hub')).toBeNull();
    expect(parseNavigationPath('/projects/agent-hub/not-a-view')).toBeNull();
    expect(parseNavigationPath('/dashboard')).toBeNull();
    expect(parseNavigationPath('')).toBeNull();
  });

  it('ignores a non-numeric or non-positive PR segment', () => {
    expect(parseNavigationPath('/projects/p/pulls/abc')?.state.prNumber).toBeNull();
    expect(parseNavigationPath('/projects/p/pulls/0')?.state.prNumber).toBeNull();
  });

  it('routes a pasted path link when there is no hash at all', () => {
    window.history.replaceState(null, '', '/projects/surveytracker/pulls/306');

    expect(getInitialNavigation()).toEqual({
      view: 'pulls',
      projectId: 'surveytracker',
      prNumber: 306,
    });
  });

  it('recovers the PR number from the path when the hash lost it', () => {
    // The exact URL older builds produced: a pasted path link plus the hash
    // the app appended, which only carried the project.
    window.history.replaceState(null, '', '/projects/surveytracker/pulls/306#/pulls/surveytracker');

    expect(readNavigationStateFromLocation()).toMatchObject({
      view: 'pulls',
      projectId: 'surveytracker',
      prNumber: 306,
    });
  });

  it('lets the hash win when it points somewhere else entirely', () => {
    window.history.replaceState(null, '', '/projects/surveytracker/pulls/306#/wiki/agent-hub');

    expect(readNavigationStateFromLocation()).toMatchObject({
      view: 'wiki',
      projectId: 'agent-hub',
      prNumber: null,
    });
  });

  it('lets the hash PR number win over the path one', () => {
    window.history.replaceState(null, '', '/projects/p/pulls/306#/pulls/p?pr=99');

    expect(readNavigationStateFromLocation()?.prNumber).toBe(99);
  });
});

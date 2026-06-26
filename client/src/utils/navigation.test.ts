import { afterEach, describe, it, expect } from 'vitest';
import {
  DEFAULT_VIEW,
  buildNavigationHash,
  getInitialNavigation,
  getInitialView,
  parseNavigationHash,
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
    });
  });

  it('round-trips currentView strings that already carry their own target', () => {
    const hash = buildNavigationHash({ view: 'kanban:agent-hub' });

    expect(hash).toBe('#/kanban%3Aagent-hub');
    expect(parseNavigationHash(hash)?.view).toBe('kanban:agent-hub');
  });
});

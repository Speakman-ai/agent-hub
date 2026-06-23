import { describe, it, expect } from 'vitest';
import { DEFAULT_VIEW, getInitialView } from './navigation';

describe('navigation defaults', () => {
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
});

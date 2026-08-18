import { describe, it, expect } from 'vitest';
import {
  sessionActionControlClass,
  sessionActionSubmenuClass,
  SESSION_ACTION_MENU_ITEM_CLASS,
  SESSION_ACTION_SUBMENU_CLASS,
} from './sessionActionMenu';

describe('sessionActionControlClass', () => {
  it('uses the menu row class for variant=menu', () => {
    expect(sessionActionControlClass('menu')).toBe(SESSION_ACTION_MENU_ITEM_CLASS);
    expect(sessionActionControlClass('menu', 'text-sky-200')).toContain('text-sky-200');
  });

  it('uses the toolbar button class otherwise', () => {
    expect(sessionActionControlClass('toolbar')).toContain('w-[150px]');
    expect(sessionActionControlClass(undefined)).toContain('w-[150px]');
  });
});

describe('sessionActionSubmenuClass', () => {
  it('uses the shared submenu class in menu variant', () => {
    expect(sessionActionSubmenuClass('menu', 'absolute bottom-full')).toBe(
      SESSION_ACTION_SUBMENU_CLASS,
    );
    expect(sessionActionSubmenuClass('toolbar', 'absolute bottom-full')).toBe(
      'absolute bottom-full',
    );
  });

  it('keeps menu-variant submenus in normal flow so the scrolling dropdown cannot clip them', () => {
    // A lateral `absolute left-full` flyout is clipped by the Actions
    // dropdown's `overflow-y-auto` (which forces `overflow-x: auto`). The
    // menu submenu must stay in-flow and within the dropdown width instead.
    expect(SESSION_ACTION_SUBMENU_CLASS).not.toContain('absolute');
    expect(SESSION_ACTION_SUBMENU_CLASS).not.toContain('left-full');
    expect(SESSION_ACTION_SUBMENU_CLASS).toContain('w-full');
  });
});

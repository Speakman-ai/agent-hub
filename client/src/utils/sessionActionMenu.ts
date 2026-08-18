/**
 * Shared classes for the session Actions dropdown and its nested controls
 * (branch picker, preview, AWS, finalize) so menu rows stay visually aligned.
 */

export type SessionActionControlVariant = 'toolbar' | 'menu';

export const SESSION_ACTION_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-gray-200 rounded-md hover:bg-gray-800/80 disabled:opacity-50 disabled:cursor-not-allowed';

export const SESSION_ACTION_MENU_ITEM_PRESSED_CLASS = 'bg-gray-800 text-white';

// The Actions dropdown is an `overflow-y-auto` scroll container, which forces
// its `overflow-x` to compute to `auto` too — a laterally positioned
// (`left-full`) flyout would be clipped into that scrollbox instead of
// appearing beside it. Menu-variant submenus therefore render in normal flow
// inside the dropdown so they stay within its bounds and scroll with it.
export const SESSION_ACTION_SUBMENU_CLASS =
  'mt-1 w-full max-h-72 overflow-auto rounded-lg border border-gray-700 bg-gray-900/80 py-1';

export const SESSION_ACTION_TOOLBAR_BUTTON_CLASS =
  'flex w-[150px] min-w-[150px] shrink-0 justify-center items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border sm:w-auto sm:min-w-0';

export function sessionActionControlClass(
  variant: SessionActionControlVariant | undefined,
  extra = '',
): string {
  const base =
    variant === 'menu' ? SESSION_ACTION_MENU_ITEM_CLASS : SESSION_ACTION_TOOLBAR_BUTTON_CLASS;
  return extra ? `${base} ${extra}` : base;
}

export function sessionActionSubmenuClass(
  variant: SessionActionControlVariant | undefined,
  toolbarClass: string,
): string {
  return variant === 'menu' ? SESSION_ACTION_SUBMENU_CLASS : toolbarClass;
}

/**
 * Canonical Lucide icon names used by the mobile shell.
 * Kept in a pure module so vitest can verify menu entries without loading RN SVG.
 */
export const HUB_ICON_NAMES = [
    'Activity',
    'BarChart3',
    'BookOpen',
    'Bot',
    'CalendarDays',
    'ChevronDown',
    'ChevronRight',
    'Clock',
    'Cloud',
    'GitBranch',
    'GitPullRequest',
    'KeyRound',
    'LayoutGrid',
    'LifeBuoy',
    'List',
    'ListOrdered',
    'Palette',
    'Play',
    'Plus',
    'ScanEye',
    'Settings',
    'ShieldAlert',
    'Sparkles',
    'StickyNote',
    'Target',
];
const HUB_ICON_SET = new Set(HUB_ICON_NAMES);
/** @param {string} name */
export function isHubIconName(name: any) {
    return HUB_ICON_SET.has(name);
}

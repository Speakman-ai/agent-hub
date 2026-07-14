/**
 * Canonical Lucide icon names used by the mobile shell.
 * Kept in a pure module so vitest can verify menu entries without loading RN SVG.
 */
export const HUB_ICON_NAMES = [
    'Activity',
    'ArrowUpRight',
    'BarChart3',
    'BookOpen',
    'Bot',
    'CalendarDays',
    'Check',
    'Circle',
    'CircleCheck',
    'FileSpreadsheet',
    'HardDrive',
    'ChevronDown',
    'ChevronRight',
    'ChevronUp',
    'Clock',
    'Cloud',
    'GitBranch',
    'GitPullRequest',
    'KeyRound',
    'LayoutGrid',
    'LifeBuoy',
    'Link2',
    'Mail',
    'MonitorPlay',
    'List',
    'ListOrdered',
    'ListTodo',
    'Palette',
    'Pencil',
    'Play',
    'Plus',
    'ScanEye',
    'ScrollText',
    'Settings',
    'ShieldAlert',
    'Sparkles',
    'StickyNote',
    'Target',
    'Terminal',
    'Trash2',
    'X',
];
const HUB_ICON_SET = new Set(HUB_ICON_NAMES);
/** @param {string} name */
export function isHubIconName(name: any) {
    return HUB_ICON_SET.has(name);
}

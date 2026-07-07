/**
 * Native (iOS/Android) icon mapping for `HubIcon`.
 *
 * Lucide SVG icons render on Expo web but are unreliable on device when
 * `react-native-svg` is not linked into the running binary (common in Expo Go
 * after adding lucide-react-native, or dev clients built before the dep).
 * Feather / MaterialCommunityIcons from `@expo/vector-icons` are font glyphs —
 * same stroke aesthetic as Lucide, always visible on native.
 *
 * @typedef {{ family: 'feather' | 'material', name: string }} NativeIconRef
 */
/** @type {Record<string, NativeIconRef>} */
export const HUB_NATIVE_ICONS: Record<string, any> = {
  Activity: { family: 'feather', name: 'activity' },
  BarChart3: { family: 'feather', name: 'bar-chart-2' },
  BookOpen: { family: 'feather', name: 'book-open' },
  Bot: { family: 'material', name: 'robot' },
  CalendarDays: { family: 'feather', name: 'calendar' },
  Check: { family: 'feather', name: 'check' },
  Circle: { family: 'feather', name: 'circle' },
  CircleCheck: { family: 'feather', name: 'check-circle' },
  FileSpreadsheet: { family: 'material', name: 'file-table' },
  HardDrive: { family: 'feather', name: 'hard-drive' },
  ChevronDown: { family: 'feather', name: 'chevron-down' },
  ChevronRight: { family: 'feather', name: 'chevron-right' },
  ChevronUp: { family: 'feather', name: 'chevron-up' },
  Clock: { family: 'feather', name: 'clock' },
  Cloud: { family: 'feather', name: 'cloud' },
  GitBranch: { family: 'feather', name: 'git-branch' },
  GitPullRequest: { family: 'feather', name: 'git-pull-request' },
  KeyRound: { family: 'feather', name: 'key' },
  LayoutGrid: { family: 'feather', name: 'grid' },
  LifeBuoy: { family: 'feather', name: 'life-buoy' },
  Mail: { family: 'feather', name: 'mail' },
  List: { family: 'feather', name: 'list' },
  ListOrdered: { family: 'material', name: 'format-list-numbered' },
  ListTodo: { family: 'material', name: 'format-list-checks' },
  Palette: { family: 'material', name: 'palette' },
  Pencil: { family: 'feather', name: 'edit-2' },
  Play: { family: 'feather', name: 'play' },
  Plus: { family: 'feather', name: 'plus' },
  ScanEye: { family: 'feather', name: 'eye' },
  Settings: { family: 'feather', name: 'settings' },
  ShieldAlert: { family: 'material', name: 'shield-alert' },
  Sparkles: { family: 'material', name: 'creation' },
  StickyNote: { family: 'feather', name: 'file-text' },
  Target: { family: 'feather', name: 'target' },
  Trash2: { family: 'feather', name: 'trash-2' },
  X: { family: 'feather', name: 'x' },
};
/**
 * Lucide renamed `BarChart3` → `ChartColumn` in v1.x; keep the web-facing
 * name as an alias for menu entries and dashboard rows.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveLucideIconName(name: any) {
  if (name === 'BarChart3') return 'ChartColumn';
  return name;
}
/** @param {string} name */
export function resolveNativeIcon(name: any) {
  return HUB_NATIVE_ICONS[name] || null;
}

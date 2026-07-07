import React from 'react';
import { Activity, BookOpen, Bot, CalendarDays, ChartColumn, Check, ChevronDown, ChevronRight, ChevronUp, Circle, CircleCheck, Clock, Cloud, FileSpreadsheet, GitBranch, GitPullRequest, HardDrive, KeyRound, LayoutGrid, LifeBuoy, Mail, List, ListOrdered, ListTodo, Palette, Pencil, Play, Plus, ScanEye, Settings, ShieldAlert, Sparkles, StickyNote, Target, Trash2, X, } from 'lucide-react-native';
import { colors } from '../theme/colors';
import { HUB_ICON_NAMES } from '../utils/hubIconNames';
import { resolveLucideIconName } from '../utils/hubIconNative';
/** Lucide SVG components for Expo web (same glyphs as the web client). */
const HUB_LUCIDE_ICONS: Record<string, any> = {
    Activity,
    BarChart3: ChartColumn,
    BookOpen,
    Bot,
    CalendarDays,
    Check,
    Circle,
    CircleCheck,
    FileSpreadsheet,
    HardDrive,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Clock,
    Cloud,
    GitBranch,
    GitPullRequest,
    KeyRound,
    LayoutGrid,
    LifeBuoy,
    Mail,
    List,
    ListOrdered,
    ListTodo,
    Palette,
    Pencil,
    Play,
    Plus,
    ScanEye,
    Settings,
    ShieldAlert,
    Sparkles,
    StickyNote,
    Target,
    Trash2,
    X,
};
for (const name of HUB_ICON_NAMES) {
    if (!HUB_LUCIDE_ICONS[name]) {
        throw new Error(`HubIcon: missing Lucide mapping for "${name}"`);
    }
}
export default function HubIcon({ name, size = 14, color = colors.gray400, strokeWidth = 2, style, }: any) {
    const lucideKey = resolveLucideIconName(name);
    const Icon = HUB_LUCIDE_ICONS[name] || HUB_LUCIDE_ICONS[lucideKey];
    if (!Icon)
        return null;
    return <Icon size={size} color={color} strokeWidth={strokeWidth} style={style}/>;
}

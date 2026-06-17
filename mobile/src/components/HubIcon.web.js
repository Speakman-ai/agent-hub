import React from 'react';
import {
  Activity,
  BookOpen,
  Bot,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  GitBranch,
  GitPullRequest,
  KeyRound,
  LayoutGrid,
  LifeBuoy,
  List,
  ListOrdered,
  Palette,
  Play,
  Plus,
  ScanEye,
  Settings,
  Sparkles,
  StickyNote,
  Target,
} from 'lucide-react-native';
import { colors } from '../theme/colors';
import { HUB_ICON_NAMES } from '../utils/hubIconNames';
import { resolveLucideIconName } from '../utils/hubIconNative';

/** Lucide SVG components for Expo web (same glyphs as the web client). */
const HUB_LUCIDE_ICONS = {
  Activity,
  BarChart3: ChartColumn,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  GitBranch,
  GitPullRequest,
  KeyRound,
  LayoutGrid,
  LifeBuoy,
  List,
  ListOrdered,
  Palette,
  Play,
  Plus,
  ScanEye,
  Settings,
  Sparkles,
  StickyNote,
  Target,
};

for (const name of HUB_ICON_NAMES) {
  if (!HUB_LUCIDE_ICONS[name]) {
    throw new Error(`HubIcon: missing Lucide mapping for "${name}"`);
  }
}

export default function HubIcon({
  name,
  size = 14,
  color = colors.gray400,
  strokeWidth = 2,
  style,
}) {
  const lucideKey = resolveLucideIconName(name);
  const Icon = HUB_LUCIDE_ICONS[name] || HUB_LUCIDE_ICONS[lucideKey];
  if (!Icon) return null;
  return <Icon size={size} color={color} strokeWidth={strokeWidth} style={style} />;
}

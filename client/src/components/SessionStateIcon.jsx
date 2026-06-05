import {
  MessageCircleQuestion,
  Loader2,
  FlaskConical,
  ScanEye,
  Clock,
  ArrowUpCircle,
  CloudUpload,
  GitMerge,
} from 'lucide-react';
import { sessionStateMeta } from '../../../shared/utils/sessionState.js';

// Map the shared metadata's icon name → the actual lucide component. Keeping
// this table here (rather than in shared) keeps `shared/` framework-free.
const ICONS = {
  MessageCircleQuestion,
  Loader2,
  FlaskConical,
  ScanEye,
  Clock,
  ArrowUpCircle,
  CloudUpload,
  GitMerge,
};

// Semantic color token → Tailwind text class. Centralized so web stays in sync
// with the shared metadata and any future surface can map the same tokens.
const COLOR_CLASS = {
  amber: 'text-amber-400',
  indigo: 'text-indigo-400',
  violet: 'text-violet-400',
  sky: 'text-sky-400',
  slate: 'text-slate-400',
  teal: 'text-teal-400',
  emerald: 'text-emerald-400',
};

const ANIM_CLASS = {
  spin: 'animate-spin',
  pulse: 'animate-pulse',
  none: '',
};

/**
 * Always-present, single-glyph indicator of a session's lifecycle state.
 * Renders one lucide icon (color + animation per the shared metadata) and never
 * returns null, so every session row carries a state icon.
 *
 * @param {{ state: string, size?: number, className?: string, testId?: string }} props
 */
export default function SessionStateIcon({
  state,
  size = 12,
  className = '',
  testId = 'session-state-icon',
}) {
  const meta = sessionStateMeta(state);
  const Icon = ICONS[meta.icon] || MessageCircleQuestion;
  const color = COLOR_CLASS[meta.color] || 'text-gray-400';
  const anim = ANIM_CLASS[meta.anim] || '';
  return (
    <Icon
      size={size}
      data-testid={testId}
      data-session-state={state}
      className={`flex-shrink-0 ${color} ${anim} ${className}`.trim()}
      aria-label={meta.label}
    >
      <title>{meta.label}</title>
    </Icon>
  );
}

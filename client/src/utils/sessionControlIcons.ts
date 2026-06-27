import {
  CloudUpload,
  FlaskConical,
  GitMerge,
  Hammer,
  MessageCircle,
  Network,
  Palette,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

/** Lucide icon per session-control value (Consult → Auto Merge). */
export const SESSION_CONTROL_ICON_MAP: Record<string, LucideIcon> = {
  consult: MessageCircle,
  design: Palette,
  scoping: Network,
  'skill-builder': Sparkles,
  manual: Hammer,
  review: FlaskConical,
  push: CloudUpload,
  merge: GitMerge,
};

export function sessionControlIcon(value: string | null | undefined): LucideIcon | null {
  if (!value) return null;
  return SESSION_CONTROL_ICON_MAP[value] ?? null;
}

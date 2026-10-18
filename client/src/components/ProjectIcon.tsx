import type { CSSProperties } from 'react';

type Props = {
  project?: { icon?: string | null; color?: string | null } | null;
  className?: string;
};

/** Project identity marker. Accent colors remain available when an icon is set. */
export default function ProjectIcon({ project, className = 'w-3 h-3 rounded-sm' }: Props) {
  const icon = project?.icon?.trim();
  const style: CSSProperties = icon
    ? {
        fontSize: 16,
        lineHeight: 1,
        minWidth: 16,
        width: 'auto',
        height: 'auto',
        backgroundColor: 'transparent',
        boxShadow: 'none',
      }
    : { backgroundColor: project?.color || '#6366f1' };
  return (
    <span
      aria-hidden="true"
      data-testid="project-icon"
      className={`inline-flex items-center justify-center flex-shrink-0 ${className}`}
      style={style}
    >
      {icon || null}
    </span>
  );
}

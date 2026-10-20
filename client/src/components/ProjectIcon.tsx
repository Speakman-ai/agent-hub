import type { CSSProperties } from 'react';
import { Folder } from 'lucide-react';

type Props = {
  project?: { icon?: string | null; color?: string | null } | null;
  className?: string;
};

/** Project identity marker. Every project uses the folder icon. */
export default function ProjectIcon({ className = '' }: Props) {
  return (
    <Folder
      aria-hidden={true}
      data-testid="project-icon"
      data-icon="Folder"
      size={16}
      strokeWidth={2}
      className={`inline-block shrink-0 text-gray-300 ${className}`}
      style={{ width: 16, height: 16, minWidth: 16 } satisfies CSSProperties}
    />
  );
}

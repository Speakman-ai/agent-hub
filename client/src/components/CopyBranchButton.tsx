import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../utils/export';

interface Props {
  branch: string;
  size?: number;
  className?: string;
}

// Icon button that copies a branch name so the user can `git checkout` it locally.
export default function CopyBranchButton({ branch, size = 13, className = '' }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!branch) return null;

  const onClick = async (e: React.MouseEvent) => {
    // Rows that host this button are often clickable themselves.
    e.stopPropagation();
    e.preventDefault();
    const ok = await copyToClipboard(branch);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const label = copied ? 'Copied branch name' : `Copy branch name ${branch}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? 'Copied' : 'Copy branch name'}
      aria-label={label}
      data-testid="copy-branch-button"
      className={`inline-flex items-center justify-center align-middle p-0.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700/60 transition-colors ${className}`}
    >
      {copied ? <Check size={size} className="text-emerald-400" /> : <Copy size={size} />}
    </button>
  );
}

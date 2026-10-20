import type { InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';

/**
 * Dark-theme checkbox. The native input stays in the label so clicks and
 * tests still use a real checkbox.
 */
export default function Checkbox({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={`relative inline-flex shrink-0 ${props.disabled ? '' : 'cursor-pointer'}`}>
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        aria-hidden
        className={`pointer-events-none flex h-4 w-4 items-center justify-center rounded border border-gray-600 bg-gray-950 text-transparent transition-colors peer-checked:border-emerald-400 peer-checked:bg-emerald-500 peer-checked:text-white peer-disabled:opacity-40 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sky-400 ${className}`}
      >
        <Check size={12} strokeWidth={3} />
      </span>
    </span>
  );
}

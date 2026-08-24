const SIZE = {
  xs: { mark: 'h-4 w-4', full: 'h-4' },
  sm: { mark: 'h-6 w-6', full: 'h-6' },
  md: { mark: 'h-7 w-7', full: 'h-7' },
  lg: { mark: 'h-10 w-10', full: 'h-10' },
} as const;

export default function BrandLogo({
  variant = 'full',
  size = 'md',
  className = '',
  alt = 'Agent Hub',
}: {
  variant?: 'full' | 'mark';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  alt?: string;
}) {
  if (variant === 'mark') {
    return (
      <img
        src="/logo-mark.png?v=3"
        alt={alt}
        className={`${SIZE[size].mark} ${className}`.trim()}
        data-testid="brand-logo-mark"
      />
    );
  }
  return (
    <img
      src="/logo.png?v=3"
      alt={alt}
      className={`${SIZE[size].full} w-auto ${className}`.trim()}
      data-testid="brand-logo"
    />
  );
}

'use client';

const VARIANTS = {
  primary:
    'bg-accent text-white hover:bg-accent-hover disabled:bg-accent/50 border border-transparent',
  secondary:
    'bg-panel text-ink border border-edge-strong hover:bg-panel-muted disabled:text-ink-faint',
  danger:
    'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50 border border-transparent',
  ghost: 'bg-transparent text-ink-muted hover:bg-panel-muted hover:text-ink border border-transparent',
};

const SIZES = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-4 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
}

export function IconButton({ label, className = '', children, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-panel-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-ink-faint ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

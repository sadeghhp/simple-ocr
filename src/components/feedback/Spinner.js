'use client';

export function Spinner({ size = 16, className = '' }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-edge-strong border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

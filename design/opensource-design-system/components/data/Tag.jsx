import React from 'react';

export function Tag({ variant = 'solid', children, style }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', height: 20, padding: "0 var(--cs-space-2)",
    borderRadius: 'var(--cs-radius-xs)', boxSizing: 'border-box', whiteSpace: 'nowrap'
  };
  const variants = {
    solid: { background: 'var(--cs-overlay-fill)', font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-70)' },
    outline: { border: '1px solid var(--cs-border-strong)', font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-55)' },
    accent: { background: 'var(--cs-accent-tint)', font: '500 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-accent-ink)' },
    mono: { background: 'var(--cs-overlay-fill)', font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-55)' },
    version: { background: 'var(--cs-success-bg)', font: '500 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-success-ink)' },
    success: { background: 'var(--cs-success-bg)', font: '500 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-success-ink)' }
  };
  return <span style={{ ...base, ...(variants[variant] || variants.solid), ...style }}>{children}</span>;
}

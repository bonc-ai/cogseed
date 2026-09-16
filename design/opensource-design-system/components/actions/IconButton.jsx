import React from 'react';

const H = { sm: 'var(--cs-control-h-sm)', md: 'var(--cs-control-h)', lg: 'var(--cs-control-h-lg)' };

export function IconButton({ size = 'md', variant = 'outline', active, disabled, children, style, onClick, title, className = '', ...rest }) {
  const h = H[size] || H.md;
  const variants = {
    outline: { background: 'var(--cs-white)', boxShadow: 'inset 0 0 0 1px var(--cs-border-field)', color: 'var(--cs-ink-60)' },
    quiet: { background: active ? 'var(--cs-overlay-fill)' : 'transparent', color: 'var(--cs-ink-60)' },
    accent: { background: 'var(--cs-accent-grad)', color: 'var(--cs-white)' },
    disabledFill: { background: 'var(--cs-overlay-disabled)', color: 'var(--cs-text-disabled)' }
  };
  const s = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: h, height: h,  borderRadius: 'var(--cs-radius-sm)', padding: 0,
    cursor: disabled ? 'not-allowed' : 'pointer', flex: 'none',
    transition: 'background var(--cs-dur-control) var(--cs-ease-out),box-shadow var(--cs-dur-hover) var(--cs-ease-out),color var(--cs-dur-control) var(--cs-ease-out)',
    ...(variants[disabled ? 'disabledFill' : variant] || variants.outline), ...style
  };
  return <button {...rest} type={rest.type || "button"} className={`cs-icon-button cs-icon-button--${variant} ${className}`} title={title} aria-label={rest["aria-label"] || title} aria-pressed={rest["aria-pressed"] ?? active} disabled={disabled} onClick={disabled ? undefined : onClick} style={{...s, '--cs-button-bg':s.background, '--cs-button-shadow':s.boxShadow, background:undefined, boxShadow:undefined}}>{children}</button>;
}

import React from 'react';
import { Spinner } from '../feedback/ProgressBar.jsx';

const H = { sm: 'var(--cs-control-h-sm)', md: 'var(--cs-control-h)', lg: 'var(--cs-control-h-lg)', login: 'var(--cs-control-h-login)' };

export function Button({
  variant = 'secondary', size = 'md', disabled, loading, icon, children,
  style, onClick, className = '', ...rest
}) {
  const h = H[size] || H.md;
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: "var(--cs-space-2)",
    height: h, padding: variant === 'ghost' ? '0 var(--cs-space-3)' : '0 var(--cs-space-4)', boxSizing: 'border-box',
     borderRadius: 'var(--cs-radius-md)', fontFamily: 'var(--cs-font-sans)',
    fontSize: 'var(--cs-size-ui)', fontWeight: 400, lineHeight: 1, cursor: 'pointer', whiteSpace: 'nowrap',
    transition: 'background var(--cs-dur-hover) var(--cs-ease-out),border-color var(--cs-dur-hover) var(--cs-ease-out),filter var(--cs-dur-hover) var(--cs-ease-out)'
  };
  const variants = {
    primary: { background: 'var(--cs-accent-grad)', color: 'var(--cs-text-on-accent)', fontWeight: 500 },
    secondary: { background: 'var(--cs-white)', color: 'var(--cs-ink-70)', boxShadow: 'inset 0 0 0 1px var(--cs-border-field)' },
    suggestion: { background: 'var(--cs-white)', color: 'var(--cs-ink-70)', boxShadow: 'inset 0 0 0 1px var(--cs-border)', borderRadius: 'var(--cs-radius-full)', fontSize: 'var(--cs-size-ui-sm)' },
    ghost: { background: 'transparent', color: 'var(--cs-ink-55)' },
    danger: { background: 'var(--cs-white)', color: 'var(--cs-critical)', boxShadow: 'inset 0 0 0 1px var(--cs-critical-border-strong)' },
    dangerSolid: { background: 'var(--cs-critical)', color: 'var(--cs-white)', fontWeight: 500 },
    ink: { background: 'var(--cs-ink)', color: 'var(--cs-white)', borderRadius: 'var(--cs-radius-sm)', padding: "0 var(--cs-space-3)" }
  };
  const disabledStyle = { background: 'var(--cs-overlay-disabled)', color: 'var(--cs-text-disabled)', boxShadow: 'none', cursor: 'not-allowed' };
  const s = { ...base, ...(variants[variant] || variants.secondary), ...(disabled ? disabledStyle : null), ...(loading ? { cursor: 'default' } : null), ...(size === 'login' ? {minWidth:280,padding:"0 var(--cs-space-13)",borderRadius:'var(--cs-radius-window)',fontSize:'var(--cs-size-body-lg)',fontWeight:500} : null), ...style };
  return (
    <button {...rest} type={rest.type || "button"} className={`cs-button cs-button--${variant} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} onClick={disabled || loading ? undefined : onClick} style={{...s, '--cs-button-bg':s.background, '--cs-button-shadow':s.boxShadow, background:undefined, boxShadow:undefined}}>
      {icon && <span className="cs-button-icon" style={{visibility:loading ? 'hidden':undefined}}>{icon}</span>}
      {loading && <span className="cs-button-spinner"><Spinner size={12} tone={variant === 'primary' || variant === 'ink' || variant === 'dangerSolid' ? 'light' : 'ink'} /></span>}
      {children}
    </button>
  );
}

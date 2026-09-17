import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

const PILL = {
  success: { bg: 'var(--cs-success-bg)', fg: 'var(--cs-success-ink)' },
  attention: { bg: 'var(--cs-attention-bg)', fg: 'var(--cs-attention-ink)' },
  critical: { bg: 'var(--cs-critical-bg)', fg: 'var(--cs-critical)' },
  neutral: { bg: 'var(--cs-overlay-fill)', fg: 'var(--cs-ink-55)' }
};
const DOT = {
  success: 'var(--cs-success)', attention: 'var(--cs-attention)',
  critical: 'var(--cs-critical)', idle: 'rgba(23,24,28,.18)'
};

export function StatusPill({ tone = 'neutral', check, children, style, className, ...rest }) {
  const t = PILL[tone] || PILL.neutral;
  return (
    <span {...rest} className={className} style={{
      display: 'inline-flex', alignItems: 'center', gap: "var(--cs-space-1)", height: 22, padding: "0 var(--cs-space-2)",
      borderRadius: 'var(--cs-radius-xs)', background: t.bg, color: t.fg,
      font: '500 var(--cs-size-meta) var(--cs-font-sans)', ...style
    }}>{check ? <Icon name="check" size={11} /> : null}{children}</span>
  );
}

export function StatusDot({ tone = 'idle', label, size = 6, style, className, ...rest }) {
  return (
    <span {...rest} className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--cs-space-2)", fontSize: 'var(--cs-size-ui-sm)', color: 'var(--cs-ink-60)', ...style }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: DOT[tone] || DOT.idle, flex: 'none' }} />
      {label}
    </span>
  );
}

export function StatusCapsule({ tone = 'success', children, style, className, ...rest }) {
  return (
    <span {...rest} className={className} style={{
      display: 'inline-flex', alignItems: 'center', gap: "var(--cs-space-1)", height: 26, padding: "0 var(--cs-space-2)",
      borderRadius: 'var(--cs-radius-full)', border: '1px solid rgba(23,24,28,.1)',
      background: 'var(--cs-white)', fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-55)', ...style
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: DOT[tone] || DOT.success }} />
      {children}
    </span>
  );
}

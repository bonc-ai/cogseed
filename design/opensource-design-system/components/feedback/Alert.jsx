import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

const TONES = {
  info: { icon: 'info', bg: 'var(--cs-surface-subtle)', border: 'rgba(23,24,28,.1)', fg: 'var(--cs-ink)', body: 'var(--cs-ink-55)', ic: 'var(--cs-ink-60)' },
  attention: { icon: 'warning', bg: 'var(--cs-attention-bg)', border: 'var(--cs-attention-border)', fg: 'var(--cs-attention-ink)', body: 'var(--cs-attention-ink)', ic: 'var(--cs-attention-ink)' },
  critical: { icon: 'error', bg: 'var(--cs-critical-bg)', border: 'var(--cs-critical-border)', fg: 'var(--cs-critical)', body: 'var(--cs-critical)', ic: 'var(--cs-critical)' },
  success: { icon: 'check', bg: 'var(--cs-success-bg-soft)', border: 'var(--cs-success-border)', fg: 'var(--cs-success-ink)', body: 'var(--cs-success-ink)', ic: 'var(--cs-success-ink)' }
};

export function Alert({ tone = 'info', title, children, action, onAction, onClose, style }) {
  const t = TONES[tone] || TONES.info;
  return (
    <div style={{
      display: 'flex', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)", border: '1px solid ' + t.border,
      borderRadius: 'var(--cs-radius-lg)', background: t.bg, alignItems: title ? 'flex-start' : 'center', ...style
    }}>
      <Icon name={t.icon} size={14} strokeWidth={tone === 'success' ? 1.8 : 1.5} color={t.ic} style={{ marginTop: 0 }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-1)", flex: 1 }}>
        {title ? <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500, color: t.fg }}>{title}</span> : null}
        <span style={{ fontSize: 'var(--cs-size-ui-sm)', lineHeight: 1.7, color: t.body }}>{children}</span>
      </span>
      {action ? <button type="button" className="cs-plain-action" disabled={!onAction} onClick={onAction} style={{ fontSize: 'var(--cs-size-ui-sm)', color: t.fg, fontWeight: 500, alignSelf: 'center', whiteSpace: 'nowrap', textDecoration: 'underline', textUnderlineOffset: 3 }}>{action}</button> : null}
      {onClose ? <button type="button" className="cs-plain-action" aria-label="关闭提示" disabled={!onClose} onClick={onClose} style={{ display: 'flex', marginTop: 0 }}><Icon name="close" size={12} color="var(--cs-text-placeholder)" /></button> : null}
    </div>
  );
}

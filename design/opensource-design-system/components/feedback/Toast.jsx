import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Toast({ tone = 'success', title, meta, action = '查看', onAction, onClose, style }) {
  return (
    <div style={{
      display: 'flex', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)", width: 360, boxSizing: 'border-box',
      background: 'var(--cs-white)', border: '1px solid rgba(23,24,28,.1)',
      borderRadius: 'var(--cs-radius-lg)', boxShadow: 'var(--cs-shadow-md)',
      animation: 'cs-in var(--cs-dur-view) var(--cs-ease-out)', ...style
    }}>
      <Icon name={tone === 'critical' ? 'error' : 'check'} size={14}
        color={tone === 'critical' ? 'var(--cs-critical)' : 'var(--cs-success)'} style={{ marginTop: "var(--cs-space-1)" }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-1)", flex: 1 }}>
        <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500 }}>{title}</span>
        {meta ? <span style={{ fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-45)' }}>{meta}</span> : null}
      </span>
      {action ? <button type="button" className="cs-plain-action" disabled={!onAction} onClick={onAction} style={{ fontSize: 'var(--cs-size-ui-sm)', color: 'var(--cs-ink-70)', fontWeight: 500, alignSelf: 'center' }}>{action}</button> : null}
      <button type="button" className="cs-plain-action" aria-label="关闭提示" disabled={!onClose} onClick={onClose} style={{ display: 'flex', marginTop: "var(--cs-space-1)" }}><Icon name="close" size={12} color="var(--cs-text-placeholder)" /></button>
    </div>
  );
}

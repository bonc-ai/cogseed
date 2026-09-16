import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Icon } from '../foundation/Icon.jsx';

export function InlineAuthBar({ state = 'ask', message, time, onAllow, onDeny, style }) {
  if (state === 'granted') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)", border: '1px solid var(--cs-success-border)', borderRadius: 'var(--cs-radius-lg)', background: 'var(--cs-success-bg-soft)', ...style }}>
        <Icon name="check" size={14} color="var(--cs-success-ink)" />
        <span style={{ fontSize: 'var(--cs-size-ui)', color: 'var(--cs-success-ink)' }}>已授权本次访问 · 记录已留痕</span>
        <span style={{ flex: 1 }} />
        {time ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-success-ink-soft)' }}>{time}</span> : null}
      </div>
    );
  }
  if (state === 'denied') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)", border: '1px solid var(--cs-border-field)', borderRadius: 'var(--cs-radius-lg)', background: 'var(--cs-surface-subtle)', ...style }}>
        <Icon name="close" size={14} color="var(--cs-ink-45)" />
        <span style={{ fontSize: 'var(--cs-size-ui)', color: 'var(--cs-ink-55)' }}>已拒绝 · 收件人需手工填写</span>
        <span style={{ flex: 1 }} />
        {time ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)' }}>{time}</span> : null}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)", border: '1px solid var(--cs-border-strong)', borderRadius: 'var(--cs-radius-lg)', background: 'var(--cs-white)', ...style }}>
      <span style={{ fontSize: 'var(--cs-size-ui)', color: 'var(--cs-ink-70)' }}>{message}</span>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" onClick={onDeny}>拒绝</Button>
      <Button variant="ink" size="sm" onClick={onAllow}>允许一次</Button>
    </div>
  );
}

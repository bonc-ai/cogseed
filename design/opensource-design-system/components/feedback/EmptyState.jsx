import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Icon } from '../foundation/Icon.jsx';

export function EmptyState({ icon = 'docLines', title, reason, action, onAction, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: "var(--cs-space-2)", animation: 'cs-in var(--cs-dur-view) var(--cs-ease-out)', ...style }}>
      <Icon name={icon} size={26} color="var(--cs-ink-24)" />
      <div style={{ fontSize: 'var(--cs-size-ui)', fontWeight: 500 }}>{title}</div>
      <div style={{ maxWidth: 420, fontSize: 'var(--cs-size-ui-sm)', lineHeight: 1.7, color: 'var(--cs-ink-45)' }}>{reason}</div>
      {action ? (
        <Button size="sm" onClick={onAction} style={{marginTop:"var(--cs-space-1)"}}>{action}</Button>
      ) : null}
    </div>
  );
}

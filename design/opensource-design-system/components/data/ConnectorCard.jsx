import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { Card, CardFooter } from '../cards/Card.jsx';
import { Switch } from '../forms/Switch.jsx';

export function ConnectorCard({ icon = 'database', name, meta, description, enabled = true, onToggle, footerAction = '权限范围', style }) {
  return (
    <Card style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)" }}>
        <span style={{ width: 30, height: 30, borderRadius: 'var(--cs-radius-md)', background: 'var(--cs-sidebar-top)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Icon name={icon} size={15} color="var(--cs-ink-70)" />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
          <span style={{ fontSize: 'var(--cs-size-body)', fontWeight: 500 }}>{name}</span>
          <span style={{ font: '400 var(--cs-size-label) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)' }}>{meta}</span>
        </span>
        <span style={{ flex: 1 }} />
        <Switch size="sm" checked={enabled} onColor="var(--cs-success)" onChange={onToggle} />
      </div>
      <p style={{ margin: "var(--cs-space-3) 0 0", fontSize: 'var(--cs-size-ui-sm)', lineHeight: 1.6, color: 'var(--cs-ink-55)' }}>{description}</p>
      <CardFooter>
        <span style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-1)", font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: enabled ? 'var(--cs-success-ink)' : 'var(--cs-ink-45)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: enabled ? 'var(--cs-success)' : 'rgba(23,24,28,.24)' }} />
          {enabled ? '正常' : '已停用'}
        </span>
        <span style={{ flex: 1 }} />
        {footerAction ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--cs-space-1)", fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-45)', cursor: 'pointer' }}>{footerAction}<Icon name="chevronRight" size={13} /></span> : null}
      </CardFooter>
    </Card>
  );
}

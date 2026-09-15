import React from 'react';
import { DropdownMenu } from './DropdownMenu.jsx';
import { Avatar } from '../data/Avatar.jsx';
import { Icon } from '../foundation/Icon.jsx';

/** Account presentation only; the host owns settings and sign-out actions. */
export function UserMenu({ name, description, onSettings, onSignOut, open, onOpenChange, style }) {
  const [hover, setHover] = React.useState(false);
  const identity = <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: "var(--cs-space-1)", textAlign: 'left' }}>
    <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    {description ? <span style={{ fontSize: 'var(--cs-size-label)', color: 'var(--cs-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={description}>{description}</span> : null}
  </span>;
  return <DropdownMenu side="top" width="100%" open={open} onOpenChange={onOpenChange}
    style={{ display: 'grid', width: '100%', ...style }}
    trigger={<button type="button" aria-label={`${name}的用户菜单`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", width: '100%', minHeight: 48, padding: "var(--cs-space-2) var(--cs-space-2)",
      border: 0, borderRadius: 'var(--cs-radius-md)', fontFamily: 'inherit', color: 'var(--cs-ink)', cursor: 'pointer',
      background: hover ? 'var(--cs-overlay-hover)' : 'transparent', transition: 'var(--cs-transition-hover)'
    }}><Avatar name={name} self />{identity}<span style={{ marginLeft: 'auto', display: 'flex', flex: 'none', color: 'var(--cs-text-muted)' }}><Icon name="chevronDown" size={14} /></span></button>}
    header={<div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)" }}><Avatar name={name} self />{identity}</div>}
    groups={[
      { items: [{ label: '设置', icon: 'settings', onSelect: onSettings }] },
      { danger: true, items: [{ label: '退出登录', icon: 'logout', onSelect: onSignOut }] }
    ]} />;
}

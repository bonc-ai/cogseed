import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function NavItem({ icon, label, count, expanded, selected, indent, size = 'md', onClick, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const h = size === 'sm' ? 'var(--cs-row-list)' : 'var(--cs-row-nav)';
  return (
    <button type="button" {...rest} aria-expanded={expanded} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        border: 0, width: '100%', textAlign: 'left', fontFamily: 'var(--cs-font-sans)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", height: h, boxSizing: 'border-box',
        padding: indent ? '0 var(--cs-space-2) 0 var(--cs-space-6)' : '0 var(--cs-space-2)', borderRadius: 'var(--cs-radius-md)',
        fontSize: size === 'sm' ? 'var(--cs-size-ui-sm)' : 'var(--cs-size-ui)', fontWeight: selected && indent ? 500 : 400,
        color: selected ? 'var(--cs-accent-ink)' : 'var(--cs-ink-70)',
        background: selected ? 'var(--cs-accent-wash)' : hover ? 'rgba(23,24,28,.045)' : 'transparent',
        cursor: 'pointer', overflow: 'hidden', transition: 'var(--cs-transition-hover)', ...style
      }}>
      {icon}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count != null ? <><span style={{ flex: 1 }} /><span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-muted)' }}>{count}</span></> : null}
      {expanded != null ? <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} /> : null}
    </button>
  );
}

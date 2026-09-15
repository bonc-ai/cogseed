import React from 'react';

export function Avatar({ name = '', size = 26, self, ring, style }) {
  const ch = name.slice(0, 1);
  const fs = size >= 36 ? 14 : 12;
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flex: 'none', textAlign: 'center', boxSizing: 'border-box',
      background: self ? 'var(--cs-accent-grad)' : 'var(--cs-avatar-bg)',
      color: self ? 'var(--cs-white)' : 'var(--cs-ink-60)',
      font: '500 ' + fs + 'px/' + (ring ? size - 4 : size) + 'px var(--cs-font-sans)',
      border: ring ? '2px solid ' + ring : 0, ...style
    }}>{ch}</span>
  );
}

export function AvatarGroup({ members = [], overflow, ring = 'var(--cs-white)', size = 26, style }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', ...style }}>
      {members.map((m, i) => (
        <Avatar key={i} name={typeof m === 'string' ? m : m.name} self={typeof m === 'object' && m.self}
          size={size} ring={ring} style={i ? { marginLeft: -8 } : null} />
      ))}
      {overflow ? (
        <span style={{
          width: size, height: size, borderRadius: '50%', textAlign: 'center', boxSizing: 'border-box',
          background: 'var(--cs-white)', color: 'var(--cs-ink-45)', font: '400 var(--cs-size-label)/' + (size - 4) + 'px var(--cs-font-sans)',
          border: '2px solid ' + ring, boxShadow: 'var(--cs-shadow-inset-hairline)', marginLeft: -8
        }}>+{overflow}</span>
      ) : null}
    </span>
  );
}

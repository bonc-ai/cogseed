import React from 'react';

export function Switch({ checked, onColor = 'var(--cs-ink)', size = 'md', onChange, style, ...rest }) {
  const w = size === 'sm' ? 32 : 34, h = size === 'sm' ? 18 : 20, k = size === 'sm' ? 14 : 16;
  return (
    <button type="button" role="switch" aria-checked={!!checked} {...rest} onClick={() => onChange && onChange(!checked)} style={{
      border: 0, padding: 0, width: w, height: h, borderRadius: 'var(--cs-radius-full)', position: 'relative', flex: 'none', cursor: 'pointer',
      background: checked ? onColor : 'rgba(23,24,28,.16)',
      transition: 'background var(--cs-dur-control) var(--cs-ease-out)', ...style
    }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? w - k - 2 : 2, width: k, height: k,
        borderRadius: '50%', background: 'var(--cs-white)', transition: 'left var(--cs-dur-control) var(--cs-ease-panel)'
      }} />
    </button>
  );
}

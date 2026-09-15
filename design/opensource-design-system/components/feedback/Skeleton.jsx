import React from 'react';

export function Skeleton({ lines = [62, 100, 88, 94], withMedia, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-3)", animation: 'cs-skeleton 1.4s ease-in-out infinite', ...style }}>
      {lines.map((w, i) => (
        <div key={i} style={{ height: i === 0 ? 13 : 10, width: w + '%', borderRadius: 'var(--cs-radius-xs)', background: i === 0 ? 'rgba(23,24,28,.09)' : 'rgba(23,24,28,.07)' }} />
      ))}
      {withMedia ? (
        <div style={{ display: 'flex', gap: "var(--cs-space-2)", marginTop: "var(--cs-space-1)" }}>
          <div style={{ height: 30, width: 30, borderRadius: 'var(--cs-radius-md)', background: 'rgba(23,24,28,.07)' }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: "var(--cs-space-2)", justifyContent: 'center' }}>
            <div style={{ height: 10, width: '44%', borderRadius: 'var(--cs-radius-xs)', background: 'rgba(23,24,28,.07)' }} />
            <div style={{ height: 9, width: '26%', borderRadius: 'var(--cs-radius-xs)', background: 'rgba(23,24,28,.06)' }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

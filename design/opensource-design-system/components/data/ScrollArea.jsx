import React from 'react';

export function ScrollArea({ header, height = 206, fade = true, children, style }) {
  return (
    <div style={{ position: 'relative', height, background: 'var(--cs-white)', border: '1px solid var(--cs-border)', borderRadius: 'var(--cs-radius-lg)', overflow: 'hidden', ...style }}>
      {header ? (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, height: 36, display: 'flex', alignItems: 'center',
          padding: "0 var(--cs-space-3)", font: 'var(--cs-type-label)', letterSpacing: 'var(--cs-tracking-label)',
          textTransform: 'uppercase', color: 'var(--cs-text-placeholder)', background: 'var(--cs-white)',
          borderBottom: '1px solid var(--cs-border-hairline)', zIndex: 'var(--cs-layer-sticky)'
        }}>{header}</div>
      ) : null}
      <div data-cs-scroll style={{ position: 'absolute', inset: (header ? 36 : 0) + 'px 0 0 0', overflow: 'auto' }}>{children}</div>
      {fade ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 28, background: 'var(--cs-fade-bottom)', pointerEvents: 'none' }} /> : null}
    </div>
  );
}

export function AspectRatio({ ratio = '16/9', children, style }) {
  return <div style={{ aspectRatio: ratio, borderRadius: 10, overflow: 'hidden', background: 'var(--cs-fill-quiet)', border: '1px solid var(--cs-border)', ...style }}>{children}</div>;
}

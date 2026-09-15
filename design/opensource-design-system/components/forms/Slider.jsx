import React from 'react';

export function Slider({ value = 60, min = 15, max = 120, ticks = [], onChange, style }) {
  const ref = React.useRef(null);
  const pct = ((value - min) / (max - min)) * 100;
  const set = (clientX) => {
    const el = ref.current; if (!el || !onChange) return;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onChange(Math.round(min + p * (max - min)));
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-2)", ...style }}>
      <div onPointerDown={e => { set(e.clientX); const mv = ev => set(ev.clientX); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); }}
        style={{ display: 'flex', alignItems: 'center', height: 14, cursor: 'pointer' }}>
        <span ref={ref} style={{ position: 'relative', flex: 1, height: 3, borderRadius: 2, background: 'rgba(23,24,28,.1)' }}>
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: 'var(--cs-ink)', borderRadius: 2 }} />
          <span style={{ position: 'absolute', top: -5.5, left: 'calc(' + pct + '% - 7px)', width: 14, height: 14, borderRadius: '50%', background: 'var(--cs-white)', boxShadow: '0 1px 2px rgba(23,24,28,.18),inset 0 0 0 1px rgba(23,24,28,.14)' }} />
        </span>
      </div>
      {ticks.length ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', font: 'var(--cs-type-numeric)', color: 'var(--cs-text-placeholder)' }}>
          {ticks.map(t => <span key={t}>{t}</span>)}
        </div>
      ) : null}
    </div>
  );
}

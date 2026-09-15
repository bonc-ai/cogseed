import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Stepper({ value = 500, step = 100, min = 0, max = 9999, onChange, width = 132, style }) {
  const btn = (side) => ({
    width: 'var(--cs-control-h)', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--cs-ink-60)',
    [side]: '1px solid var(--cs-overlay-disabled)',
    transition: 'var(--cs-transition-hover)'
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', width, height: 'var(--cs-control-h)', border: '1px solid var(--cs-border-field)', borderRadius: 'var(--cs-radius-field)', background: 'var(--cs-white)', boxSizing: 'border-box', ...style }}>
      <button type="button" className="cs-plain-action" aria-label="减少数值" disabled={!onChange || value<=min} onClick={() => onChange(Math.max(min, value - step))} style={btn('borderRight')}><Icon name="minus" size={13} /></button>
      <span style={{ flex: 1, textAlign: 'center', font: '500 var(--cs-size-ui) var(--cs-font-sans)' }}>{value}</span>
      <button type="button" className="cs-plain-action" aria-label="增加数值" disabled={!onChange || value>=max} onClick={() => onChange(Math.min(max, value + step))} style={btn('borderLeft')}><Icon name="plus" size={13} /></button>
    </div>
  );
}

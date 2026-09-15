import React from 'react';

/** Radios share a caller-provided name; native inputs own keyboard selection. */
export function Radio({ checked, disabled, label, name, value, onChange, style }) {
  return <label className="cs-radio" style={style}>
    <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange?.(true)} />
    <span>{label}</span>
  </label>;
}
export function RadioCard({ checked, disabled, title, help, name, value, onChange, style }) {
  const helpId=React.useId();
  return <label className="cs-radio cs-radio-card" style={style}>
    <input type="radio" name={name} value={value} checked={checked} disabled={disabled} aria-describedby={help ? helpId : undefined} onChange={() => onChange?.(true)} />
    <span><span className="cs-radio-title">{title}</span>{help && <span id={helpId} className="cs-radio-help">{help}</span>}</span>
  </label>;
}

import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Input({ size = 'lg', icon, suffix, prefix, invalid, valid, disabled, mono, style, onFocus, onBlur, ...rest }) {
  const h = size === 'md' ? 'var(--cs-control-h)' : 'var(--cs-control-h-lg)';
  const box = {
    display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", height: h, boxSizing: 'border-box',
    padding: "0 var(--cs-space-3)", borderRadius: 'var(--cs-radius-field)',
    background: disabled ? 'var(--cs-overlay-hover)' : 'var(--cs-white)',
    border: '1px solid ' + (invalid ? 'var(--cs-critical-border-strong)' : disabled ? 'var(--cs-overlay-disabled)' : 'var(--cs-border-field)'),
    transition: 'border-color var(--cs-dur-hover) var(--cs-ease-out),box-shadow var(--cs-dur-hover) var(--cs-ease-out)', ...style
  };
  const input = {
    flex: 1, minWidth: 0, border: 0, background: 'transparent',
    fontFamily: mono ? 'var(--cs-font-sans)' : 'var(--cs-font-sans)',
    fontSize: size === 'md' ? 'var(--cs-size-ui)' : 'var(--cs-size-body)',
    color: disabled ? 'var(--cs-text-disabled)' : 'var(--cs-ink)',
    cursor: disabled ? 'not-allowed' : 'text'
  };
  const [focus, setFocus] = React.useState(false);
  if (focus && !disabled) { if (!invalid) box.borderColor = 'var(--cs-border-control)'; }
  return (
    <div className="cs-field-shell" style={box}>
      {prefix ? <span style={{ font: '400 var(--cs-size-ui-sm) var(--cs-font-sans)', color: 'var(--cs-ink-45)' }}>{prefix}</span> : null}
      {icon ? <Icon name={icon} size={15} color="var(--cs-ink-45)" /> : null}
      <input disabled={disabled} onFocus={e => {setFocus(true);onFocus?.(e);}} onBlur={e => {setFocus(false);onBlur?.(e);}} style={input} {...rest} />
      {invalid ? <Icon name="alert" size={14} color="var(--cs-critical)" /> : null}
      {valid && !invalid ? <Icon name="check" size={14} color="var(--cs-success)" /> : null}
      {suffix ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)' }}>{suffix}</span> : null}
    </div>
  );
}

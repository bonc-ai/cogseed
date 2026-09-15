import React from 'react';

export function Tabs({ items = [], value = 0, onChange, style, ariaLabel }) {
  const enabled = items.map((it, i) => typeof it === 'object' && it.disabled ? -1 : i).filter(i => i >= 0);
  const entry = enabled.includes(value) ? value : enabled[0];
  const onKeyDown = (event, index) => {
    if (event.isComposing || event.keyCode === 229 || !enabled.length) return;
    const position = enabled.indexOf(index);
    let next;
    if (event.key === 'ArrowRight') next = enabled[(position + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(position - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    else return;
    event.preventDefault();
    event.currentTarget.parentElement.children[next].focus();
    if (onChange) onChange(next);
  };
  return (
    <div className="cs-tabs" role="tablist" aria-label={ariaLabel} style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-4)", borderBottom: '1px solid var(--cs-border-hairline)', ...style }}>
      {items.map((it, i) => {
        const label = typeof it === 'string' ? it : it.label;
        const count = typeof it === 'string' ? undefined : it.count;
        const disabled = typeof it === 'object' && it.disabled;
        const active = i === value;
        return (
          <button type="button" role="tab" aria-selected={active} disabled={disabled} key={label} tabIndex={i === entry ? 0 : -1} onKeyDown={event => onKeyDown(event, i)} onFocus={event => event.currentTarget.scrollIntoView({block:'nearest',inline:'nearest'})} onClick={disabled ? undefined : () => onChange && onChange(i)} style={{
            flexShrink: 0, whiteSpace: 'nowrap', border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 'var(--cs-size-ui-sm)', fontWeight: active ? 500 : 400, padding: "var(--cs-space-3) 0",
            color: disabled ? 'var(--cs-text-disabled)' : active ? 'var(--cs-ink)' : 'var(--cs-ink-45)',
            cursor: disabled ? 'not-allowed' : 'pointer', transition: 'color var(--cs-dur-hover) var(--cs-ease-out)'
          }}>
            {label}
            {count != null ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-muted)', marginLeft: "var(--cs-space-1)" }}>{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

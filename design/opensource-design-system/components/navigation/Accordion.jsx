import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Accordion({ items = [], defaultOpen = [0], style }) {
  const id = React.useId();
  const [open, setOpen] = React.useState(defaultOpen);
  const toggle = i => setOpen(o => o.includes(i) ? o.filter(x => x !== i) : [...o, i]);
  return (
    <div style={{ background: 'var(--cs-white)', border: '1px solid var(--cs-border)', borderRadius: 'var(--cs-radius-lg)', ...style }}>
      {items.map((it, i) => {
        const isOpen = open.includes(i);
        const last = i === items.length - 1;
        return (
          <React.Fragment key={it.title}>
            <button type="button" className="cs-plain-action cs-accordion-trigger" aria-expanded={isOpen} aria-controls={`${id}-${i}`} onClick={() => toggle(i)} style={{
              display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "var(--cs-space-3) var(--cs-space-3)",
              borderBottom: last && !isOpen ? 'none' : '1px solid var(--cs-border-hairline)', cursor: 'pointer'
            }}>
              <span style={{ display: 'flex', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform var(--cs-dur-panel) var(--cs-ease-panel)' }}>
                <Icon name="chevronDown" size={13} color="var(--cs-ink-60)" />
              </span>
              <span style={{ fontSize: 'var(--cs-size-ui)', fontWeight: isOpen ? 500 : 400, color: 'var(--cs-ink)' }}>{it.title}</span>
              <span style={{ flex: 1 }} />
              {it.meta ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)' }}>{it.meta}</span> : null}
            </button>
            {(
              <div id={`${id}-${i}`} hidden={!isOpen} style={{
                padding: "var(--cs-space-1) var(--cs-space-3) var(--cs-space-3) var(--cs-space-8)", font: '400 var(--cs-size-ui-sm)/1.85 var(--cs-font-sans)',
                color: 'var(--cs-ink-55)', borderBottom: last ? 'none' : '1px solid var(--cs-border-hairline)',
                animation: 'cs-in var(--cs-dur-panel) var(--cs-ease-out)'
              }}>{it.body}</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

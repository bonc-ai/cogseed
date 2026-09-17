import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function TagInput({ tags = [], max = 9, placeholder = '继续输入…', onChange, style, id, 'aria-describedby':describedBy, 'aria-invalid':invalid, 'aria-label':label }) {
  const [draft, setDraft] = React.useState('');
  const add = () => { const v = draft.trim(); if (v && tags.length < max && onChange) onChange([...tags, v]); setDraft(''); };
  return (
    <div className="cs-field-shell" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: "var(--cs-space-1)", padding: "var(--cs-space-2) var(--cs-space-2)", minHeight: 36, boxSizing: 'border-box', border: '1px solid var(--cs-border-field)', borderRadius: 'var(--cs-radius-field)', background: 'var(--cs-white)', ...style }}>
      {tags.map(t => (
        <span key={t} style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-1)", height: 22, padding: "0 var(--cs-space-1) 0 var(--cs-space-2)", borderRadius: 'var(--cs-radius-xs)', background: 'var(--cs-overlay-fill)', fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-70)' }}>
          {t}<button type="button" aria-label={`移除${t}`} onClick={() => onChange && onChange(tags.filter(x => x !== t))} style={{ display: 'flex', cursor: 'pointer',border:0,padding:"var(--cs-space-1)",background:'transparent' }}>
            <Icon name="close" size={10} color="var(--cs-ink-45)" /></button>
        </span>
      ))}
      <input id={id} aria-describedby={describedBy} aria-invalid={invalid} aria-label={label} value={draft} placeholder={placeholder} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Backspace' && !draft && tags.length && onChange) onChange(tags.slice(0, -1)); }}
        style={{ flex: 1, minWidth: 80, border: 0, background: 'transparent', font: '400 var(--cs-size-ui-sm) var(--cs-font-sans)', color: 'var(--cs-ink)' }} />
    </div>
  );
}

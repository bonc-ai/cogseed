import React from 'react';

export function Textarea({ minHeight = 64, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <textarea onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={{
      display: 'block', width: '100%', boxSizing: 'border-box', padding: "var(--cs-space-3) var(--cs-space-3)",
      borderRadius: 'var(--cs-radius-field)', background: 'var(--cs-white)',
      border: '1px solid ' + (focus ? 'var(--cs-border-control)' : 'var(--cs-border-field)'),
      resize: 'none', minHeight,
      font: '400 var(--cs-size-body)/1.75 var(--cs-font-sans)', color: 'var(--cs-ink-body)',
      transition: 'border-color var(--cs-dur-hover) var(--cs-ease-out),box-shadow var(--cs-dur-hover) var(--cs-ease-out)', ...style
    }} {...rest} />
  );
}

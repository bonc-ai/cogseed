import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Field({ label, optional, help, error, count, children, style }) {
  const generated = React.useId();
  const child = React.isValidElement(children) ? children : null;
  const id = child?.props.id || generated;
  const messageId = generated + '-message';
  const control = child ? React.cloneElement(child, {id, 'aria-describedby':[child.props['aria-describedby'], (error || help || count) ? messageId : null].filter(Boolean).join(' ') || undefined, 'aria-invalid':error ? true : child.props['aria-invalid']}) : children;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-2)", ...style }}>
      {label ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: "var(--cs-space-1)" }}>
          <label htmlFor={id} style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500 }}>{label}</label>
          {optional ? <span style={{ fontSize: 'var(--cs-size-caption)', color: 'var(--cs-text-placeholder)' }}>选填</span> : null}
        </div>
      ) : null}
      {control}
      {error ? (
        <div id={messageId} role="alert" style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-1)", fontSize: 'var(--cs-size-caption)', color: 'var(--cs-critical)' }}>
          <Icon name="alert" size={12} />{error}
        </div>
      ) : null}
      {!error && (help || count) ? (
        <div id={messageId} style={{ display: 'flex', fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-45)' }}>
          <span>{help}</span><span style={{ flex: 1 }} />
          {count ? <span style={{ fontFamily: 'var(--cs-font-sans)' }}>{count}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

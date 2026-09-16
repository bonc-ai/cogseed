import React from 'react';

export function TaskListItem({ status = 'idle', title, meta, time, selected, last, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  const dot = { success: 'var(--cs-success)', attention: 'var(--cs-attention)', critical: 'var(--cs-critical)', idle: 'rgba(23,24,28,.18)' }[status];
  return (
    <button type="button" className="cs-plain-action cs-task-row" aria-pressed={!!selected} disabled={!onClick} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: "var(--cs-space-3)", padding: "var(--cs-space-3) var(--cs-space-2)", margin: '0 -4px',
        borderRadius: 'var(--cs-radius-md)',
        borderBottom: last ? 'none' : '1px solid var(--cs-border-subtle)',
        background: selected ? 'var(--cs-accent-wash)' : hover ? 'var(--cs-overlay-hover-soft)' : 'transparent',
        transition: 'var(--cs-transition-hover)', ...style
      }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flex: 'none' }} />
      <span style={{ fontSize: 'var(--cs-size-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      {meta ? <span className="cs-task-row-meta" style={{ font: '400 var(--cs-size-caption) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)', flex: 'none' }}>{meta}</span> : null}
      <span style={{ flex: 1 }} />
      {time ? <span style={{ fontSize: 'var(--cs-size-ui-sm)', color: 'var(--cs-ink-45)', flex: 'none' }}>{time}</span> : null}
    </button>
  );
}

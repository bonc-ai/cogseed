import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { Spinner } from './ProgressBar.jsx';

export function StepList({ steps = [], style }) {
  return (
    <div style={{ border: '1px solid var(--cs-border)', borderRadius: 'var(--cs-radius-lg)', overflow: 'hidden', background: 'var(--cs-white)', ...style }}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "var(--cs-space-2) var(--cs-space-3)", minHeight: 40, boxSizing: 'border-box',
            borderBottom: last ? 'none' : '1px solid var(--cs-border-hairline)',
            background: s.state === 'running' ? 'var(--cs-surface-subtle)' : 'var(--cs-white)',
            transition: 'background var(--cs-dur-panel) var(--cs-ease-out)'
          }}>
            {s.state === 'done' ? <Icon name="check" size={14} color="var(--cs-success)" />
              : s.state === 'running' ? <Spinner size={14} tone="attention" />
              : <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.4px solid var(--cs-border-strong)', flex: 'none' }} />}
            <span style={{ fontSize: 'var(--cs-size-ui-sm)', color: s.state === 'wait' ? 'var(--cs-text-placeholder)' : 'var(--cs-ink-70)' }}>
              {s.label}{s.state === 'running' ? '…' : ''}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-text-placeholder)' }}>{s.meta}</span>
          </div>
        );
      })}
    </div>
  );
}

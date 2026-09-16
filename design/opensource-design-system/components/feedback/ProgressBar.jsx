import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function ProgressBar({ value = 0, max = 100, tone = 'ink', maxWidth, style }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <span style={{ display: 'block', flex: 1, height: 3, borderRadius: 2, background: 'rgba(23,24,28,.08)', position: 'relative', maxWidth, overflow: 'hidden', ...style }}>
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', borderRadius: 2,
        background: tone === 'attention' ? 'var(--cs-attention)' : 'var(--cs-ink)',
        transition: 'width var(--cs-dur-progress) var(--cs-ease-panel)'
      }} />
    </span>
  );
}

export function Spinner({ size = 13, tone = 'ink', style }) {
  const colors = { ink: 'var(--cs-ink-60)', attention: 'var(--cs-attention)', light: 'var(--cs-white)' };
  return <Icon name="loader" size={size} color={colors[tone] || colors.ink} style={{
    animation: 'cs-spin ' + (tone === 'attention' ? '1.1s' : '.9s') + ' linear infinite', ...style
  }} />;
}

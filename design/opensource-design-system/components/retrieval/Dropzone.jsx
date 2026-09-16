import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Dropzone({ hint = 'XLSX · CSV · PDF · DOCX · 单个 ≤ 50MB', label = '松手即上传到本次任务', style }) {
  return (
    <div style={{
      height: 104, border: '1.5px dashed var(--cs-accent-dash)', borderRadius: 'var(--cs-radius-lg)',
      background: 'var(--cs-accent-wash-soft)', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: "var(--cs-space-1)", ...style
    }}>
      <Icon name="upload" size={20} color="var(--cs-accent)" />
      <div style={{ fontSize: 'var(--cs-size-ui)', color: 'var(--cs-accent-ink)' }}>{label}</div>
      <div style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-45)' }}>{hint}</div>
    </div>
  );
}

export function FileRow({ name, meta, state = 'ready', progress = 0, action, onRemove, style }) {
  const blocked = state === 'blocked';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: "var(--cs-space-3)", height: 48, padding: "0 var(--cs-space-3)", boxSizing: 'border-box',
      background: blocked ? 'var(--cs-critical-bg)' : 'var(--cs-white)',
      border: '1px solid ' + (blocked ? 'var(--cs-critical-border)' : 'rgba(23,24,28,.1)'),
      borderRadius: 10, ...style
    }}>
      <Icon name={blocked ? 'alert' : state === 'ready' ? 'fileCheck' : 'file'} size={16}
        color={blocked ? 'var(--cs-critical)' : state === 'ready' ? 'var(--cs-success)' : 'var(--cs-ink-60)'} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cs-space-1)', flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: "var(--cs-space-2)" }}>
          <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500, color: blocked ? 'var(--cs-critical)' : 'var(--cs-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ flex: 1 }} />
          {state === 'uploading' ? <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-45)' }}>{progress}%</span> : null}
        </span>
        {state === 'uploading' ? (
          <span style={{ height: 3, borderRadius: 2, background: 'rgba(23,24,28,.1)', overflow: 'hidden' }}>
            <span style={{ display: 'block', width: progress + '%', height: 3, background: 'var(--cs-ink)', borderRadius: 2 }} />
          </span>
        ) : (
          <span style={{ font: blocked ? '400 var(--cs-size-meta) var(--cs-font-sans)' : '400 var(--cs-size-meta) var(--cs-font-sans)', color: blocked ? 'var(--cs-critical)' : 'var(--cs-ink-45)' }}>{meta}</span>
        )}
      </span>
      {action ? <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500, color: 'var(--cs-critical)', whiteSpace: 'nowrap', cursor: 'pointer' }}>{action}</span>
        : <button type="button" className="cs-plain-action" aria-label={`移除 ${name || "文件"}`} disabled={!onRemove} onClick={onRemove} style={{ display: 'flex', cursor: 'pointer' }}><Icon name="close" size={12} color="var(--cs-text-placeholder)" /></button>}
    </div>
  );
}

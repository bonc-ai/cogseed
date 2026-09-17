import React from 'react';
import { Button } from '../actions/Button.jsx';

/** Adjacent confirmation: the host retains its operation, retention rules and state. */
export function InlineConfirm({title,description,confirmLabel,cancelLabel='取消',danger=true,onCancel,onConfirm,style}) {
  const id=React.useId();
  return <section role="group" aria-labelledby={id} style={{padding:'var(--cs-space-4)',marginBlock:'var(--cs-space-4)',border:'1px solid var(--cs-border-field)',borderRadius:'var(--cs-radius-lg)',font:'var(--cs-type-ui)',...style}}>
    <strong id={id} style={{fontWeight:500}}>{title}</strong>
    {description&&<p style={{margin:"var(--cs-space-2) 0 0",color:'var(--cs-text-secondary)',lineHeight:1.75}}>{description}</p>}
    <div style={{display:'flex',justifyContent:'flex-end',flexWrap:'wrap',gap:"var(--cs-space-2)",marginTop:"var(--cs-space-4)"}}><Button onClick={onCancel}>{cancelLabel}</Button><Button variant={danger?'danger':'secondary'} onClick={onConfirm}>{confirmLabel}</Button></div>
  </section>;
}

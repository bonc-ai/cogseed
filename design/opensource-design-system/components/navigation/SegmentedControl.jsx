import React from 'react';
export function SegmentedControl({ items = [], value = 0, onChange, style, ariaLabel = '筛选' }) {
  return <div role="group" aria-label={ariaLabel} style={{display:'inline-flex',maxWidth:'100%',overflowX:'auto',padding:"var(--cs-space-1)",background:'var(--cs-overlay-fill)',borderRadius:'var(--cs-radius-md)',gap:"var(--cs-space-1)",...style}}>
    {items.map((item,i)=><button type="button" key={i} className="cs-segment" aria-pressed={i===value} onClick={()=>onChange?.(i)}>{item}</button>)}
  </div>;
}

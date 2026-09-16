import React from 'react';

/** Controlled navigation; terminal and collapsed segments are never actions. */
export function Breadcrumb({ items = [], onNavigate, style }) {
  return <nav aria-label="面包屑" style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:'var(--cs-space-2)',fontSize:'var(--cs-size-ui-sm)',color:'var(--cs-text-muted)',...style}}>
    {items.map((item,index)=><React.Fragment key={index}>
      {index>0&&<span aria-hidden="true">/</span>}
      {index<items.length-1&&item!=='…'&&onNavigate
        ? <button type="button" className="cs-plain-action" onClick={()=>onNavigate(item,index)}>{item}</button>
        : <span aria-current={index===items.length-1?'page':undefined}>{item}</span>}
    </React.Fragment>)}
  </nav>;
}

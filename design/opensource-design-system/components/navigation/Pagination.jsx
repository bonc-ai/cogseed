import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

export function Pagination({ page = 1, pageCount = 9, total, pageSize = 200, onChange, locale = 'zh-CN', style }) {
  const count=Math.max(1,pageCount), current=Math.max(1,Math.min(page,count));
  const pages=[...new Set([1,count,current-1,current,current+1].filter(n=>n>=1&&n<=count))].sort((a,b)=>a-b);
  return <nav className="cs-pagination" aria-label="分页" style={style}>
    <button type="button" aria-label="上一页" disabled={current===1 || !onChange} onClick={()=>onChange(current-1)}><Icon name="chevronLeft" size={13} /></button>
    {pages.map((n,i)=><React.Fragment key={n}>{i>0&&n-pages[i-1]>1&&<span aria-hidden="true">…</span>}<button type="button" aria-label={`第 ${n} 页`} aria-current={n===current?'page':undefined} disabled={!onChange} onClick={()=>onChange(n)}>{n}</button></React.Fragment>)}
    <button type="button" aria-label="下一页" disabled={current===count || !onChange} onClick={()=>onChange(current+1)}><Icon name="chevronRight" size={13} /></button>
    {total!=null && <span className="cs-pagination-total">共 {total.toLocaleString(locale)} 条 · 每页 {pageSize} · 第 {current} 页</span>}
  </nav>;
}

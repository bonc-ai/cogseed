import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { FloatingPanel } from '../feedback/FloatingPanel.jsx';

export function SearchableSelect({options=[],value,recent=[],total,onChange,placeholder='搜索',style,id:providedId,'aria-label':ariaLabel,'aria-labelledby':labelledBy,'aria-describedby':describedBy,'aria-invalid':invalid}) {
  const generated=React.useId(),id=providedId||generated;
  const trigger=React.useRef(null),panel=React.useRef(null),search=React.useRef(null);
  const [open,setOpen]=React.useState(false),[q,setQ]=React.useState('');
  const shown=options.filter(o=>o.includes(q));
  const mark=o=>{const i=q?o.indexOf(q):-1;return i<0?o:<>{o.slice(0,i)}<b style={{fontWeight:600}}>{q}</b>{o.slice(i+q.length)}</>;};
  const close=()=>{setOpen(false);trigger.current?.focus();};
  React.useEffect(()=>{
    if(!open)return;
    const frame=requestAnimationFrame(()=>search.current?.focus());
    const outside=e=>{if(!trigger.current?.contains(e.target)&&!panel.current?.contains(e.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside);};
  },[open]);
  const keyDown=e=>{
    if(e.isComposing||e.keyCode===229)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
    if(e.key==='Tab'){e.preventDefault();close();return;}
    if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
    e.preventDefault();
    const items=Array.from(panel.current?.querySelectorAll('[role=option]')||[]),i=items.indexOf(document.activeElement);
    if(e.key==='ArrowUp'&&i<=0)search.current?.focus();else items[e.key==='ArrowDown'?(i+1)%items.length:i-1]?.focus();
  };
  return <div style={{minWidth:0,...style}}>
    <button type="button" id={id} ref={trigger} className="cs-select-trigger" aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id+'-search':undefined} style={{height:'var(--cs-control-h-lg)'}} onClick={()=>setOpen(v=>!v)} onKeyDown={e=>{if(e.isComposing||e.keyCode===229)return;if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);}}}>
      <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{value||placeholder}</span><Icon name="chevronDown" size={14}/>
    </button>
    {open&&<FloatingPanel anchorRef={trigger} panelRef={panel} width={260} role="dialog" id={id+'-search'} aria-label={ariaLabel||placeholder} onKeyDown={keyDown}>
      <div style={{display:'flex',alignItems:'center',gap:"var(--cs-space-2)",padding:"var(--cs-space-2) var(--cs-space-3)",borderBottom:'1px solid var(--cs-border-hairline)'}}><Icon name="search" size={14}/><input ref={search} aria-label={placeholder} value={q} onChange={e=>setQ(e.target.value)} placeholder={placeholder} style={{width:'100%',minWidth:0,border:0,font:'var(--cs-type-ui)',background:'transparent'}}/></div>
      <div role="listbox" aria-label="搜索结果" style={{padding:"var(--cs-space-1)",maxHeight:240,overflow:'auto'}} data-cs-scroll>
        {!shown.length&&<div role="status" style={{padding:"var(--cs-space-3)",font:'var(--cs-type-ui)',color:'var(--cs-text-muted)'}}>没有匹配项，换个关键词试试。</div>}
        {shown.map(o=><button type="button" role="option" tabIndex={-1} aria-selected={o===value} className="cs-menu-item" key={o} onClick={()=>{onChange?.(o);close();}}><span className="cs-menu-check">{o===value&&<Icon name="check" size={14}/>}</span><span>{mark(o)}</span><span style={{flex:1}}/>{recent.includes(o)&&<span style={{font:'var(--cs-type-label)',color:'var(--cs-text-muted)'}}>最近</span>}</button>)}
      </div>
      <div style={{padding:"var(--cs-space-2) var(--cs-space-3)",borderTop:'1px solid var(--cs-border-hairline)',font:'var(--cs-type-label)',color:'var(--cs-text-muted)'}}>共 {total??options.length} 条 · 显示 {shown.length} 条</div>
    </FloatingPanel>}
  </div>;
}

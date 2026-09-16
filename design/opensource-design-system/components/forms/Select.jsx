import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { FloatingPanel } from '../feedback/FloatingPanel.jsx';

export function Select({options=[],value,placeholder='请选择',groupLabel,onChange,size='lg',disabledOptions=[],disabled=false,style,id:providedId,'aria-label':ariaLabel,'aria-labelledby':labelledBy,'aria-describedby':describedBy,'aria-invalid':invalid}) {
  const generated=React.useId(), id=providedId || generated, listId=id+'-options';
  const trigger=React.useRef(null), panel=React.useRef(null);
  const [open,setOpen]=React.useState(false);
  const enabled=options.filter(o=>!disabledOptions.includes(o));
  const all=[...options,...disabledOptions.filter(o=>!options.includes(o))];
  const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
  React.useEffect(()=>{
    if(!open) return;
    const outside=e=>{if(!trigger.current?.contains(e.target)&&!panel.current?.contains(e.target))close();};
    document.addEventListener('pointerdown',outside);
    const frame=requestAnimationFrame(()=>{
      const buttons=panel.current?.querySelectorAll('[role=option]:not(:disabled)');
      (Array.from(buttons || []).find(n=>n.getAttribute('aria-selected')==='true') || buttons?.[0])?.focus();
    });
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside);};
  },[open]);
  const keyDown=e=>{
    if(e.isComposing || e.keyCode===229)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);return;}
    if(e.key==='Tab'){e.preventDefault();close(true);const targets=Array.from(document.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(n=>!panel.current?.contains(n)&&n.getClientRects().length);const i=targets.indexOf(trigger.current);targets[i+(e.shiftKey?-1:1)]?.focus();return;}
    const buttons=Array.from(panel.current?.querySelectorAll('[role=option]:not(:disabled)') || []);
    const i=buttons.indexOf(document.activeElement);
    let next;
    if(e.key==='ArrowDown')next=(i+1)%buttons.length;
    if(e.key==='ArrowUp')next=(i-1+buttons.length)%buttons.length;
    if(e.key==='Home')next=0;
    if(e.key==='End')next=buttons.length-1;
    if(next!==undefined){e.preventDefault();buttons[next]?.focus();}
  };
  return <div style={{minWidth:0,...style}}>
    <button type="button" ref={trigger} id={id} className="cs-select-trigger" disabled={disabled} aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined}
      style={{height:size==='md'?'var(--cs-control-h)':'var(--cs-control-h-lg)',fontSize:size==='md'?'var(--cs-size-ui)':'var(--cs-size-body)'}}
      onClick={()=>setOpen(v=>!v)} onKeyDown={e=>{if(e.isComposing||e.keyCode===229)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);}}}>
      <span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:value==null?'var(--cs-text-placeholder)':undefined}}>{value??placeholder}</span><Icon name="chevronDown" size={14}/>
    </button>
    {open&&<FloatingPanel anchorRef={trigger} panelRef={panel} width={Math.max(236,trigger.current?.getBoundingClientRect().width || 0)} onKeyDown={keyDown} style={{padding:"var(--cs-space-1)"}}>
      {groupLabel&&<div style={{padding:"var(--cs-space-2)",font:'var(--cs-type-label)',color:'var(--cs-text-muted)'}}>{groupLabel}</div>}
      <div role="listbox" id={listId} aria-label={ariaLabel || groupLabel || placeholder}>
        {all.map(o=><button type="button" role="option" key={o} aria-selected={o===value} disabled={!enabled.includes(o)} tabIndex={-1} className="cs-menu-item" onClick={()=>{onChange?.(o);close(true);}}><span className="cs-menu-check">{o===value&&<Icon name="check" size={14}/>}</span>{o}</button>)}
      </div>
    </FloatingPanel>}
  </div>;
}

import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { FloatingPanel, focusAnchor } from '../feedback/FloatingPanel.jsx';

export function DropdownMenu({trigger,groups=[],open,onOpenChange,width=232,align='start',side='bottom',header,style}) {
  const [inner,setInner]=React.useState(false), root=React.useRef(null), panel=React.useRef(null);
  const isOpen=open??inner, id=React.useId();
  const change=next=>{if(open==null)setInner(next);onOpenChange?.(next);};
  const close=(restore=false)=>{change(false);if(restore)focusAnchor(root);};
  React.useEffect(()=>{
    if(!isOpen)return;
    const outside=e=>{if(!root.current?.contains(e.target)&&!panel.current?.contains(e.target))close();};
    document.addEventListener('pointerdown',outside);
    const frame=requestAnimationFrame(()=>panel.current?.querySelector('[role=menuitem]')?.focus());
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside);};
  },[isOpen]);
  const keyDown=e=>{
    if(e.isComposing||e.keyCode===229)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);return;}
    if(e.key==='Tab'){e.preventDefault();close(true);return;}
    const items=Array.from(panel.current?.querySelectorAll('[role=menuitem]')||[]),i=items.indexOf(document.activeElement);
    let next;
    if(e.key==='ArrowDown')next=(i+1)%items.length;
    if(e.key==='ArrowUp')next=(i-1+items.length)%items.length;
    if(e.key==='Home')next=0;
    if(e.key==='End')next=items.length-1;
    if(next!==undefined){e.preventDefault();items[next]?.focus();}
  };
  const triggerProps={'aria-expanded':isOpen,'aria-haspopup':'menu','aria-controls':isOpen?id:undefined,
    onClick:e=>{trigger?.props?.onClick?.(e);if(!e.defaultPrevented)change(!isOpen);},
    onKeyDown:e=>{trigger?.props?.onKeyDown?.(e);if(e.defaultPrevented||e.isComposing||e.keyCode===229)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();change(true);}}};
  return <div ref={root} style={{display:'inline-flex',...style}}>
    {React.isValidElement(trigger)?React.cloneElement(trigger,triggerProps):<button type="button" {...triggerProps}>{trigger || '更多操作'}</button>}
    {isOpen&&<FloatingPanel anchorRef={root} panelRef={panel} width={width} align={align} side={side} onKeyDown={keyDown} style={{padding:"var(--cs-space-1)"}}>
      {header&&<div style={{padding:"var(--cs-space-2) var(--cs-space-3) var(--cs-space-3)",borderBottom:'1px solid var(--cs-border-hairline)',marginBottom:"var(--cs-space-1)"}}>{header}</div>}
      <div role="menu" id={id} aria-label="更多操作">{groups.map((g,gi)=><React.Fragment key={gi}>
        {gi>0&&<div role="separator" style={{height:1,background:'var(--cs-border-hairline)',margin:"var(--cs-space-1) var(--cs-space-2)"}}/>}
        {g.label&&<div style={{padding:"var(--cs-space-2)",font:'var(--cs-type-label)',color:'var(--cs-text-muted)'}}>{g.label}</div>}
        {g.items.map((it,i)=><button type="button" role="menuitem" tabIndex={-1} key={i} className={'cs-menu-item'+(g.danger?' cs-menu-item--danger':'')} style={{minHeight:'var(--cs-row-menu)'}} onClick={()=>{it.onSelect?.();close(true);}}>
          {it.icon&&<Icon name={it.icon} size={14}/>}<span style={{overflowWrap:'anywhere'}}>{it.label}</span><span style={{flex:1}}/>
          {it.shortcut&&<span style={{font:'var(--cs-type-label)',color:'var(--cs-text-muted)'}}>{it.shortcut}</span>}{it.submenu&&<Icon name="chevronRight" size={13}/>}</button>)}
      </React.Fragment>)}</div>
    </FloatingPanel>}
  </div>;
}

import React from 'react';
import { IconButton } from '../actions/IconButton.jsx';
import { Icon } from '../foundation/Icon.jsx';
import { Button } from '../actions/Button.jsx';

const modals=[], originalInert=new Map();
let originalOverflow, isolationObserver;
function refreshIsolation(){
  const top=modals[modals.length-1];
  for(const node of document.body.children){
    if(!originalInert.has(node))originalInert.set(node,node.inert);
    node.inert=node!==top;
  }
}
function isolateModal(backdrop){
  if(!modals.length){originalOverflow=document.body.style.overflow;document.body.style.overflow='hidden';isolationObserver=new MutationObserver(refreshIsolation);isolationObserver.observe(document.body,{childList:true});}
  modals.push(backdrop);refreshIsolation();
  return ()=>{
    modals.splice(modals.indexOf(backdrop),1);
    if(modals.length){refreshIsolation();return;}
    isolationObserver.disconnect();for(const [node,inert] of originalInert)node.inert=inert;originalInert.clear();document.body.style.overflow=originalOverflow;
  };
}


export function Dialog({title,description,extra,cancelLabel='取消',confirmLabel,danger,width=420,onCancel,onConfirm,children,confirmDisabled=false,initialFocus='cancel',showClose=false,style}) {
  const panel=React.useRef(null), cancel=React.useRef(null), titleId=React.useId(), descriptionId=React.useId();
  const cancelRef=React.useRef(onCancel);cancelRef.current=onCancel;
  const close=()=>cancelRef.current?.();
  React.useEffect(()=>{
    const previous=document.activeElement;
    const release=isolateModal(panel.current?.parentElement);
    const first=initialFocus==='first' ? panel.current?.querySelector('textarea:not(:disabled),input:not(:disabled),select:not(:disabled),[data-dialog-initial-focus]') : null;
    (first || cancel.current?.querySelector('button'))?.focus();
    const keyboard=e=>{
      if(modals[modals.length-1]!==panel.current?.parentElement)return;
      if(e.isComposing || e.keyCode===229 || e.defaultPrevented)return;
      if(e.key==='Escape'&&panel.current?.querySelector('[data-cs-floating]'))return;
      if(e.key==='Escape'){e.preventDefault();close();return;}
      if(e.key!=='Tab')return;
      const targets=Array.from(panel.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') || []).filter(n=>n.getClientRects().length);
      const first=targets[0],last=targets[targets.length-1];
      if(!targets.length){e.preventDefault();panel.current?.focus();}
      else if(e.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&(document.activeElement===last||!panel.current?.contains(document.activeElement))){e.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',keyboard);
    return ()=>{release();document.removeEventListener('keydown',keyboard);if(previous?.isConnected)previous.focus();};
  },[]);
  // Keep the latest callback without moving focus when the parent rerenders.
  return window.ReactDOM.createPortal(<div onClick={close} style={{position:'fixed',inset:0,background:'var(--cs-scrim)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:'var(--cs-layer-modal)'}}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description?descriptionId:undefined} tabIndex={-1} onClick={e=>e.stopPropagation()} style={{width:`min(${width}px, calc(100vw - 32px))`,maxHeight:'calc(100dvh - 32px)',overflowY:'auto',background:'var(--cs-white)',borderRadius:'var(--cs-radius-window)',boxShadow:'var(--cs-shadow-window)',...style}}>
      <div style={{padding:"var(--cs-space-4) var(--cs-space-6) 0"}}><div style={{display:'flex',alignItems:'center',gap:'var(--cs-space-3)'}}><h2 id={titleId} style={{margin:0,fontSize:'var(--cs-size-dialog-title)',fontWeight:400,lineHeight:1.35}}>{title}</h2>{showClose&&<IconButton title="关闭" variant="quiet" onClick={close} style={{marginLeft:'auto'}}><Icon name="close" size={16}/></IconButton>}</div>
        {description&&<p id={descriptionId} style={{margin:"var(--cs-space-3) 0 0",font:'var(--cs-type-ui)',lineHeight:1.75,color:'var(--cs-text-secondary)'}}>{description}</p>}
      </div>
      {children&&<div style={{padding:'var(--cs-space-4) var(--cs-space-6) 0'}}>{children}</div>}
      <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:"var(--cs-space-2)",padding:"var(--cs-space-6)"}}>{extra}<span style={{flex:1}}/>
        <span ref={cancel}><Button onClick={close}>{cancelLabel}</Button></span>
        <Button disabled={confirmDisabled} variant={danger?'dangerSolid':'ink'} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </div>
  </div>,document.body);
}

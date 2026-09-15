import React from 'react';

// Shared preview-only placement: portals escape scroll containers; dimensions stay in the viewport.
export function FloatingPanel({anchorRef, panelRef, side='bottom', align='start', width=280, children, style, ...rest}) {
  const localRef=React.useRef(null), ref=panelRef || localRef;
  const [placement,setPlacement]=React.useState({visibility:'hidden'});
  React.useLayoutEffect(()=>{
    const update=()=>{
      const anchor=anchorRef?.current, panel=ref.current;
      if(!anchor || !panel) return;
      const a=anchor.getBoundingClientRect(), gap=6, edge=8;
      const vw=document.documentElement.clientWidth, vh=window.innerHeight;
      const below=Math.max(0,vh-a.bottom-gap-edge), above=Math.max(0,a.top-gap-edge);
      const natural=Math.min(panel.scrollHeight,vh-edge*2);
      const useTop=side==='top' ? above>=natural || above>=below : below<natural && above>below;
      const available=useTop ? above:below, height=Math.min(natural,available);
      const requested=style?.width ?? width;
      const w=Math.min(vw-edge*2,typeof requested==='number' ? requested : typeof requested==='string' && requested.endsWith('%') ? a.width*parseFloat(requested)/100 : panel.getBoundingClientRect().width);
      setPlacement({visibility:'visible',zIndex:anchor.closest('[aria-modal="true"]')?'var(--cs-layer-modal-popover)':'var(--cs-layer-popover)',width:w,left:Math.max(edge,Math.min(align==='end'?a.right-w:a.left,vw-w-edge)),
        top:Math.max(edge,useTop?a.top-gap-height:a.bottom+gap),maxHeight:available});
    };
    update();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);
    if(ref.current) observer?.observe(ref.current);
    window.addEventListener('resize',update);
    window.addEventListener('scroll',update,true);
    return ()=>{observer?.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
  },[anchorRef,ref,side,align,width,style?.width]);
  const portalHost=anchorRef?.current?.closest('[aria-modal="true"]') || document.body;
  return window.ReactDOM.createPortal(<div {...rest} ref={ref} data-cs-floating style={{
    width,maxWidth:'calc(100vw - 16px)',boxSizing:'border-box',background:'var(--cs-white)',
    border:'1px solid var(--cs-border-field)',borderRadius:'var(--cs-radius-lg)',boxShadow:'var(--cs-shadow-md)',
    ...style,position:'fixed',zIndex:'var(--cs-layer-modal-popover)',overflowY:'auto',...placement
  }}>{children}</div>,portalHost);
}

export function focusAnchor(ref) {
  const node=ref?.current;
  (node?.matches('button,input,textarea,[tabindex]')?node:node?.querySelector('button,input,textarea,[tabindex]'))?.focus();
}

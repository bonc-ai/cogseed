import React from 'react';
import { FloatingPanel } from './FloatingPanel.jsx';
import { Button } from '../actions/Button.jsx';
import { Icon } from '../foundation/Icon.jsx';

// Anchored mode adds positioning and dismissal; static callers keep their existing surface.
export function Popover({ title, badge, children, footer, width = 280, style,
  open, onOpenChange, anchorRef, returnFocusRef, align = 'start', label, dismissible = true }) {
  const panelRef = React.useRef(null);
  const anchored = open !== undefined;
  const closeRef = React.useRef(onOpenChange);
  closeRef.current = onOpenChange;
  React.useEffect(() => {
    if (!anchored || !open || !dismissible) return;
    const outside = e => {
      if (!panelRef.current?.contains(e.target) && !anchorRef?.current?.contains(e.target)) closeRef.current?.(false);
    };
    const escape = e => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      e.preventDefault(); e.stopPropagation();
      closeRef.current?.(false);
      const target = returnFocusRef?.current || anchorRef?.current;
      (target?.matches('button,input,textarea') ? target : target?.querySelector('button,input,textarea'))?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [anchored, open, anchorRef, returnFocusRef, dismissible]);
  if (anchored && !open) return null;
  const padding = anchored ? 'var(--cs-space-2) var(--cs-space-3)' : 'var(--cs-space-3) var(--cs-space-4)';
  const Surface = anchored ? FloatingPanel : 'div';
  return <Surface {...(anchored ? {anchorRef,panelRef,side:'top',align} : {ref:panelRef})} role={anchored ? 'group' : undefined} aria-label={label || title} style={{
    width, boxSizing: 'border-box', background: 'var(--cs-white)', border: '1px solid var(--cs-border-field)',
    borderRadius: 'var(--cs-radius-lg)', boxShadow: 'var(--cs-shadow-md)', overflow: 'hidden',
    animation: 'cs-in var(--cs-dur-hover) var(--cs-ease-out)', ...style
  }}>
    {title && <div style={{ padding, borderBottom: '1px solid var(--cs-border-hairline)', display: 'flex', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--cs-size-ui-sm)', fontWeight: 500 }}>{title}</span><span style={{ flex: 1 }} />
      {badge && <span style={{ fontSize: 'var(--cs-size-caption)', color: 'var(--cs-text-muted)' }}>{badge}</span>}
    </div>}
    <div style={{ padding, fontSize: 'var(--cs-size-ui-sm)', lineHeight: 1.8, color: 'var(--cs-ink-55)' }}>{children}</div>
    {footer && <div style={{ padding: anchored ? 'var(--cs-space-2) var(--cs-space-3)' : 'var(--cs-space-3) var(--cs-space-4)', borderTop: '1px solid var(--cs-border-hairline)',
      fontSize: 'var(--cs-size-caption)', color: 'var(--cs-ink-45)' }}>{footer}</div>}
  </Surface>;
}

/** Action rows omit selection semantics; single-choice rows receive selected. */
export function PopoverItem({ label, description, icon, selected, trailing, onClick }) {
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return <Button variant="ghost" aria-pressed={selected} onClick={onClick}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
    style={{ width: '100%', minHeight: description ? 44 : 32, height: 'auto', padding: "var(--cs-space-1) var(--cs-space-2)", gap: "var(--cs-space-2)",
      fontSize: 'var(--cs-size-ui-sm)', justifyContent: 'flex-start', whiteSpace: 'normal',
      background: hover || focus ? 'var(--cs-overlay-hover)' : 'transparent',
      border: 0, cursor: onClick ? 'pointer' : 'default' }}>
    {icon && <Icon name={icon} size={14} />}
    <span style={{ flex: 1, minWidth: 0, textAlign: 'left', lineHeight: 1.4 }}>
      <span style={{ display: 'block', color: 'var(--cs-ink)', overflowWrap: 'anywhere' }}>{label}</span>
      {description && <span style={{ display: 'block', fontSize: 'var(--cs-size-caption)', color: 'var(--cs-text-muted)' }}>{description}</span>}
    </span>
    {selected !== undefined && <span style={{ width: 14 }}>{selected && <Icon name="check" size={14} />}</span>}
    {trailing}
  </Button>;
}

export function Tooltip({label,children,style}) {
  const [on,setOn]=React.useState(false), timer=React.useRef(), anchor=React.useRef(null), id=React.useId();
  const hide=()=>{clearTimeout(timer.current);setOn(false);};
  React.useEffect(()=>()=>clearTimeout(timer.current),[]);
  const content=React.isValidElement(children)?React.cloneElement(children,{'aria-describedby':on?[children.props['aria-describedby'],id].filter(Boolean).join(' '):children.props['aria-describedby']}):children;
  return <span ref={anchor} style={{display:'inline-flex',...style}} onMouseEnter={()=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setOn(true),400);}} onMouseLeave={()=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setOn(false),80);}} onFocus={()=>{clearTimeout(timer.current);setOn(true);}} onBlur={hide} onKeyDown={e=>{if(e.key==='Escape'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();hide();}}}>
    {content}{on&&<FloatingPanel anchorRef={anchor} width="max-content" role="tooltip" id={id} style={{padding:"var(--cs-space-1) var(--cs-space-2)",pointerEvents:'none',background:'var(--cs-ink)',color:'var(--cs-white)',font:'var(--cs-type-caption)',border:0,borderRadius:'var(--cs-radius-xs)'}}>{label}</FloatingPanel>}
  </span>;
}

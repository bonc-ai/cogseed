import React from 'react';

export function Checkbox({checked,indeterminate,disabled,label,help,onChange,style}) {
  const input=React.useRef(null),helpId=React.useId();
  React.useEffect(()=>{if(input.current)input.current.indeterminate=!!indeterminate;},[indeterminate]);
  return <label className="cs-radio" style={style}>
    <input ref={input} type="checkbox" checked={checked} disabled={disabled} aria-label={label || '选择'} aria-describedby={help ? helpId : undefined} onChange={e=>onChange?.(e.target.checked)} />
    {label && <span><span className="cs-radio-title">{label}</span>{help && <span className="cs-radio-help" id={helpId}>{help}</span>}</span>}
  </label>;
}

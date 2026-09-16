import React from 'react';
import { Button } from '../actions/Button.jsx';
import { Input } from '../forms/Input.jsx';

const PRESETS = ['近 7 天', '近 30 天', '本季度', '上季度', '本年至今'];

export function DateRangePicker({ value = {start:'',end:''}, preset = '', presets = PRESETS, onPreset, onChange, presetRanges = {}, style }) {
  const structured=typeof value!=='string';
  const [draft,setDraft]=React.useState(structured?value:{start:'',end:''});
  const [error,setError]=React.useState('');
  const errorId=React.useId();
  React.useEffect(()=>{if(structured){setDraft(value);setError('');}},[structured,value.start,value.end]);
  const validDate=text=>!text||(/^\d{4}-\d{2}-\d{2}$/.test(text)&&!Number.isNaN(Date.parse(text))&&new Date(text).toISOString().slice(0,10)===text);
  const commit=(next,badInput=false)=>{
    setDraft(next);
    const message=badInput||!validDate(next.start)||!validDate(next.end)?'日期不存在，请按 YYYY-MM-DD 填写。':next.start&&next.end&&next.start>next.end?'开始日期不能晚于结束日期，请调整日期范围。':'';
    setError(message);
    if(message)return false;
    onChange?.(next);return true;
  };
  return <div className="cs-date-range" style={{display:'flex',flexDirection:'column',gap:'var(--cs-space-3)',...style}}>
    {structured?<>
      <div className="cs-date-range-fields">
        {['start','end'].map(key=><label key={key}>{key==='start'?'开始日期':'结束日期'}
          <Input type="date" aria-label={key==='start'?'开始日期':'结束日期'} value={draft[key]} disabled={!onChange} invalid={!!error} aria-invalid={!!error} aria-describedby={error?errorId:undefined}
            onChange={e=>commit({...draft,[key]:e.target.value},!!e.target.validity?.badInput)}/>
        </label>)}
      </div>
      {error&&<span id={errorId} role="alert" style={{fontSize:'var(--cs-size-ui-sm)',color:'var(--cs-critical)'}}>{error}</span>}
    </>:<span>{value}</span>}
    <div style={{display:'flex',flexWrap:'wrap',gap:'var(--cs-space-1)'}}>
      {presets.map(p=>{const on=p===preset;return <button type="button" className="cs-plain-action" aria-pressed={on} disabled={structured?!(onChange&&presetRanges[p]):!onPreset} key={p}
        onClick={()=>{if(structured&&!commit({...presetRanges[p]}))return;onPreset?.(p);}} style={{height:24,padding:'0 var(--cs-space-2)',borderRadius:'var(--cs-radius-xs)',background:on?'var(--cs-accent-tint)':'var(--cs-overlay-fill)',font:'400 var(--cs-size-caption)/24px var(--cs-font-sans)',color:on?'var(--cs-accent-ink)':'var(--cs-ink-70)'}}>{p}</button>;})}
      {structured&&<Button size="sm" variant="ghost" disabled={!onChange} onClick={()=>{commit({start:'',end:''});onPreset?.('');}}>清空日期</Button>}
    </div>
  </div>;
}

export function Calendar({ month = '2026 年 9 月', days = 30, startWeekday = 1, rangeStart = 1, rangeEnd = 15, footer = '已选 15 天', onSelect, style }) {
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  return (
    <div style={{ width: 276, boxSizing: 'border-box', background: 'var(--cs-white)', border: '1px solid rgba(23,24,28,.1)', borderRadius: 'var(--cs-radius-lg)', boxShadow: 'var(--cs-shadow-md)', padding: "var(--cs-space-3)", ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: "var(--cs-space-2)" }}>

        <span style={{ flex: 1, textAlign: 'center', font: '500 var(--cs-size-ui-sm) var(--cs-font-sans)' }}>{month}</span>

      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: "var(--cs-space-1)" }}>
        {['一', '二', '三', '四', '五', '六', '日'].map((w, i) => (
          <span key={w} style={{ height: 24, font: '400 var(--cs-size-label)/24px var(--cs-font-sans)', textAlign: 'center', color: i > 4 ? 'var(--cs-ink-24)' : 'var(--cs-text-placeholder)' }}>{w}</span>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <span key={'e' + i} style={{ height: 30 }} />;
          const inRange = d >= rangeStart && d <= rangeEnd;
          const isEnd = d === rangeEnd;
          const weekend = (i % 7) > 4;
          return <button type="button" className="cs-plain-action" key={d} disabled={!onSelect} aria-label={`${month} ${d} 日`} aria-pressed={inRange} onClick={()=>onSelect?.(d)} style={{
            height: 30, textAlign: 'center',
            font: (isEnd ? '500' : '400') + ' 12px/30px var(--cs-font-sans)',
            color: isEnd ? 'var(--cs-white)' : !inRange ? 'var(--cs-text-secondary)' : weekend ? 'var(--cs-text-placeholder)' : 'var(--cs-ink-70)',
            background: isEnd ? 'var(--cs-ink)' : inRange ? (weekend ? 'var(--cs-accent-wash-soft)' : 'var(--cs-accent-wash)') : 'transparent',
            borderRadius: isEnd ? 'var(--cs-radius-sm)' : 0
          }}>{d}</button>;
        })}
      </div>
      <div style={{ marginTop: "var(--cs-space-2)", paddingTop: "var(--cs-space-2)", borderTop: '1px solid var(--cs-border-hairline)', display: 'flex', alignItems: 'center' }}>
        <span style={{ font: '400 var(--cs-size-meta) var(--cs-font-sans)', color: 'var(--cs-ink-45)' }}>{footer}</span>
        <span style={{ flex: 1 }} />

      </div>
    </div>
  );
}

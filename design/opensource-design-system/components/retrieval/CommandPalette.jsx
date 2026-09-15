import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Button } from '../actions/Button.jsx';

function Mark({ text = '', query }) {
  const parts = [], lower = String(text).toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  let from = 0, at = needle ? lower.indexOf(needle) : -1;
  while (at >= 0) { parts.push(text.slice(from, at), <b key={at}>{text.slice(at, at + query.length)}</b>); from = at + query.length; at = lower.indexOf(needle, from); }
  return <>{parts}{text.slice(from)}</>;
}

// Local corpus filtering only. Consumers own authorization, data loading and navigation.
export function CommandPalette({ query, defaultQuery = '', onQueryChange, groups = [], onSelect, onClose, history = [], onHistoryChange, modal = false, open = true, footer, style }) {
  const [localQuery, setLocalQuery] = React.useState(defaultQuery), [tab, setTab] = React.useState('all'), [active, setActive] = React.useState(0);
  const input = React.useRef(null), panel = React.useRef(null), backdrop = React.useRef(null), latest = React.useRef(null), listId = React.useId();
  const value = query === undefined ? localQuery : query, needle = value.trim();
  const matches = needle ? groups.map((g, i) => ({ ...g, key: g.id || g.label || String(i), items: g.items.filter(it => [it.title, it.meta, it.snippet].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle.toLocaleLowerCase())) })) : [];
  const visibleGroups = matches.filter(g => (tab === 'all' || g.key === tab) && g.items.length).map(g => ({ ...g, total: g.items.length, items: tab === 'all' ? g.items.slice(0, 10) : g.items }));
  const rows = visibleGroups.flatMap(g => g.items.map(item => ({ item, group: g })));
  const index = Math.min(active, Math.max(0, rows.length - 1));
  function change(next) { setLocalQuery(next); setActive(0); onQueryChange?.(next); }
  function remember() { if (needle) onHistoryChange?.([needle, ...history.filter(q => q !== needle)].slice(0, 12)); }
  function close() { remember(); onClose?.(); }
  function select(row) { if (!row) return; remember(); onSelect?.(row.item, row.group); }
  latest.current = { close };
  React.useEffect(() => { setActive(0); }, [value, tab]);
  React.useEffect(() => {
    if (!modal || !open) return;
    const previous = document.activeElement, inert = new Map(), overflow = document.body.style.overflow;
    for (const node of document.body.children) { inert.set(node, node.inert); if (node !== backdrop.current) node.inert = true; }
    document.body.style.overflow = 'hidden'; input.current?.focus();
    const keydown = e => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); latest.current.close(); }
      if (e.key !== 'Tab') return;
      const targets = Array.from(panel.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []).filter(n => n.getClientRects().length);
      const first = targets[0], last = targets[targets.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); for (const [node, old] of inert) node.inert = old; document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [modal, open]);
  React.useEffect(() => { panel.current?.querySelector(`[data-search-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  function inputKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) setActive((index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length); }
    if (e.key === 'Enter') { e.preventDefault(); select(rows[index]); }
    if (!modal && e.key === 'Escape') { e.preventDefault(); close(); }
  }
  if (!open) return null;
  let flat = -1;
  const content = <div ref={panel} className="cs-search" role={modal ? 'dialog' : 'region'} aria-modal={modal || undefined} aria-label="全局搜索" style={style}>
    <div className="cs-search-input-row">
      <Icon name="search" size={16} />
      <input ref={input} aria-label="搜索任务、资料库内容" placeholder="搜索任务、资料库内容…" value={value} onChange={e => change(e.target.value)} onKeyDown={inputKey} aria-controls={listId} />
      {onClose && <IconButton variant="quiet" title="关闭搜索" aria-label="关闭搜索" onClick={close}><Icon name="close" size={16} /></IconButton>}
    </div>
    {needle && <div className="cs-search-tabs" role="group" aria-label="搜索分类">{[{key:'all',label:'全部'}, ...groups.map(g => ({key:g.id || g.label,label:g.label}))].map(g => <Button key={g.key} size="sm" variant="ghost" aria-pressed={tab === g.key} onClick={() => {setTab(g.key);setActive(0);}}>{g.label}</Button>)}</div>}
    <div id={listId} className="cs-search-body">
      {!needle ? history.length ? <><div className="cs-search-heading"><span>搜索历史</span><Button variant="ghost" size="sm" onClick={() => onHistoryChange?.([])}>清空</Button></div><div className="cs-search-history">{history.map(q => <Button key={q} variant="secondary" size="sm" onClick={() => { change(q); input.current?.focus(); }}>{q}</Button>)}</div></> : <div className="cs-search-empty" role="status">输入关键词开始搜索</div> : rows.length ? visibleGroups.map(g => <section key={g.key} aria-label={g.label}>
        <div className="cs-search-heading">{g.label}</div>
        {g.items.map(item => { const n = ++flat; return <button key={item.id || `${item.title}-${n}`} type="button" data-search-index={n} className={`cs-search-result${n === index ? ' is-active' : ''}`} onMouseEnter={() => setActive(n)} onFocus={() => setActive(n)} onClick={() => select({item,group:g})}>
          <Icon name={item.icon || 'file'} size={16} /><span className="cs-search-result-copy"><span className="cs-search-result-title"><span className="cs-search-kind">{g.label}</span><Mark text={item.title} query={needle} /></span>{item.meta && <span className="cs-search-meta"><Mark text={item.meta} query={needle} /></span>}{item.snippet && <span className="cs-search-snippet"><Mark text={item.snippet} query={needle} /></span>}</span>
        </button>; })}
        {g.total > g.items.length && <Button variant="ghost" size="sm" onClick={() => {setTab(g.key);setActive(0);}}>查看更多 ({g.total})</Button>}
      </section>) : <div className="cs-search-empty" role="status">未找到「{needle}」相关内容</div>}
    </div>
    {footer && <div className="cs-search-footer">{footer}</div>}
  </div>;
  return modal ? window.ReactDOM.createPortal(<div ref={backdrop} className="cs-search-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>{content}</div>, document.body) : content;
}

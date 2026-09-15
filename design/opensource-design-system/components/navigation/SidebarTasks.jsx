import React from 'react';
import { Button } from '../actions/Button.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Input } from '../forms/Input.jsx';
import { Icon } from '../foundation/Icon.jsx';

// Preview-only interaction state. Source contract: conversation.js task rows,
// _conversationActionItems, merge picker and renderConversationList.
// Running, queue and plan are independent snapshots, never a business lifecycle.
function normalize(recent, pinned, spaces) {
  const rows = new Map();
  const add = (raw, extra = {}) => {
    const t = typeof raw === 'string' ? { title: raw } : raw;
    const match=extra.pinned&&!t.id?[...rows.values()].filter(row=>row.title===t.title):[];
    const id = t.id || (match.length===1?match[0].id:extra.spaceId?`${extra.spaceId}::${t.title}`:t.title);
    rows.set(id, { ...rows.get(id), ...t, id, ...extra });
  };
  recent.forEach(t => add(t));
  spaces.forEach(s => (s.tasks || []).forEach(t => add(t, { spaceId: s.id || s.name })));
  pinned.forEach(t => add(t, { pinned: true }));
  return [...rows.values()];
}
export function SidebarTasks({ recent = [], pinned = [], spaces = [], items, initialFolded = {}, initialMenuId,
  selectedId, onOpen, onDeleteActive }) {
  const incoming=items || normalize(recent,pinned,spaces);
  const signature=JSON.stringify(incoming);
  const [tasks, setTasks] = React.useState(() => incoming);
  const sourceIds=React.useRef(new Set(incoming.map(t=>t.id)));
  const overrides=React.useRef(new Map());
  const deleted=React.useRef(new Set());
  // Reconcile only source changes; fresh array identities must not reset menu edits.
  React.useEffect(()=>{
    const previous=sourceIds.current;
    const nextIds=new Set(incoming.map(t=>t.id));
    setTasks(rows=>[
      ...incoming.filter(t=>!deleted.current.has(t.id)).map(t=>({...t,...overrides.current.get(t.id)})),
      ...rows.filter(t=>!previous.has(t.id)&&!nextIds.has(t.id)&&!deleted.current.has(t.id))
    ]);
    sourceIds.current=nextIds;
  },[signature]);
  const dialogTitleId = React.useId();
  const [limit,setLimit] = React.useState(12);
  const [active, setActive] = React.useState(selectedId);
  const [folded, setFolded] = React.useState(initialFolded);
  const [spacesCollapsed, setSpacesCollapsed] = React.useState(false);
  const [menu, setMenu] = React.useState(null);
  const [edit, setEdit] = React.useState(null);
  const [value, setValue] = React.useState('');
  const [modal, setModal] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [chosen, setChosen] = React.useState([]);
  const [notice, setNotice] = React.useState('');
  const host = React.useRef(null);
  const dialog = React.useRef(null);
  const menuEl = React.useRef(null);
  const returnFocus = React.useRef(null);
  const serial = React.useRef(0);
  const groupSpaces = spaces.map(s => ({ ...s, id: s.id || s.name }));
  React.useEffect(() => setActive(selectedId), [selectedId]);
  React.useEffect(() => {
    if (!initialMenuId) return;
    host.current?.querySelector(`[data-task-menu="${initialMenuId}"]`)?.click();
  }, []);
  React.useEffect(() => {
    if (!modal) return;
    dialog.current?.showModal();
  }, [modal]);
  React.useEffect(() => {
    if (!menu) return;
    menuEl.current?.querySelector('button')?.focus();
    const dismiss = e => {
      if (!menuEl.current?.contains(e.target) && !returnFocus.current?.contains(e.target)) setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', close); };
  }, [menu]);
  const update = (id, patch) => {overrides.current.set(id,{...overrides.current.get(id),...patch});setTasks(rows => rows.map(t => t.id === id ? {...t, ...patch} : t));};
  const open = t => { setActive(t.id); onOpen?.(t); };
  const closeModal = () => { setModal(null); returnFocus.current?.focus(); };
  const makeTask = title => ({id:`preview-${++serial.current}`,title,time:'刚刚'});
  const begin = (action, task) => {
    setMenu(null); setNotice('');
    if (action === 'pin') { update(task.id, {pinned:!task.pinned}); setNotice(task.pinned ? '已取消置顶' : '已置顶'); return; }
    if (action === 'rename') { setEdit({id:task.id}); setValue(task.title || ''); return; }
    setQuery(''); setChosen([task.id]); setModal({action,task});
  };
  const saveName = () => {
    if (!value.trim()) return;
    if (edit.id) update(edit.id,{title:value.trim()});
    else { const t = {...makeTask(value.trim()),spaceId:edit.spaceId}; setTasks(rows => [t,...rows]); open(t); }
    setEdit(null);
  };
  const editor = <form className="cs-task-editor" onSubmit={e => {e.preventDefault(); saveName();}}>
    <Input size="md" autoFocus aria-label={edit?.id ? '任务名称' : '新任务名称'} placeholder="填写任务名称" value={value} maxLength={500}
      onChange={e => setValue(e.target.value)} onKeyDown={e => {
        if (e.isComposing || e.keyCode === 229) { if (e.key === 'Enter') e.preventDefault(); return; }
        if (e.key === 'Escape') {setEdit(null);returnFocus.current?.focus();}
      }} />
    <div className="cs-task-edit-actions"><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>取消</Button><Button size="sm" type="submit" disabled={!value.trim()}>保存</Button></div>
  </form>;
  const row = t => <div key={t.id} className={`cs-sidebar-task-row ${active === t.id ? 'is-selected' : ''} ${menu?.task.id === t.id ? 'is-menu-open' : ''}`}>
    {edit?.id === t.id ? editor : <>
      <button className={`cs-task-open ${!t.title ? 'is-untitled' : ''}`} onClick={() => open(t)} aria-current={active === t.id ? 'page' : undefined} title={t.title || '新任务'}>
        <span className="cs-task-title">{t.running > 0 && <span className="cs-task-indicator" role="img" aria-label="运行中" title="运行中" />}<span>{t.title || '新任务'}</span></span>
      </button>
      <span className="cs-task-time" title={t.absoluteTime || t.time}>{t.time}</span>
      <IconButton className="cs-task-more" variant="quiet" size="sm" title={`${t.title || '新任务'}的更多操作`} aria-label={`${t.title || '新任务'}的更多操作`} aria-haspopup="menu" aria-expanded={menu?.task.id === t.id} data-task-menu={t.id}
        onClick={e => {returnFocus.current=e.currentTarget; const rect=e.currentTarget.getBoundingClientRect(); setMenu(menu?.task.id === t.id ? null : {task:t,left:Math.max(8,Math.min(rect.right-176,window.innerWidth-184)),top:Math.max(8,Math.min(rect.bottom+4,window.innerHeight-252))});}}>⋯</IconButton>
    </>}
  </div>;
  const group = (key, label, rows, spaceId, create = false) => <section key={key} className="cs-task-group">
    <div className="cs-task-group-head"><button onClick={() => setFolded(f => ({...f,[key]:!f[key]}))} aria-expanded={!folded[key]}>
      <Icon name={folded[key] ? 'chevronRight' : 'chevronDown'} size={12}/>{spaceId && <Icon name="space" size={14} color="var(--cs-text-muted)" />}<span>{label}</span>{spaceId && <small>{rows.length}</small>}
    </button>{create && <IconButton variant="quiet" size="sm" title={`在${label}中新建任务`} aria-label={`在${label}中新建任务`} onClick={() => {setFolded(f => ({...f,[key]:false}));setValue('');setEdit({spaceId});}}><Icon name="plus" size={13}/></IconButton>}</div>
    {!folded[key] && <>{edit && !edit.id && edit.spaceId === spaceId && create && editor}{rows.map(row)}</>}
  </section>;
  const pins = tasks.filter(t => t.pinned);
  const recentTasks = tasks.filter(t => !t.pinned && !t.spaceId);
  const channels = [...new Set(recentTasks.map(t => t.channel).filter(Boolean))];
  const visibleSpaces = groupSpaces.filter(s => tasks.some(t => !t.pinned && t.spaceId === s.id));
  const source = modal?.task;
  const finish = () => {
    if (modal.action === 'delete') {
      deleted.current.add(source.id);
      setTasks(rows => rows.filter(t => t.id !== source.id));
      if (active === source.id) {setActive(null);onDeleteActive?.();}
      setNotice('已删除任务');
    } else {
      const t = makeTask(modal.action === 'copy' ? `${source.title || '新任务'}（副本）` : '合并任务');
      if (modal.action === 'copy') t.auto = source.auto;
      setTasks(rows => [t,...rows]);setFolded(f => ({...f,recent:false}));open(t);
      setNotice(modal.action === 'copy' ? '已复制任务' : `已合并 ${chosen.length} 个任务`);
    }
    closeModal();
  };
  return <div className="cs-sidebar-tasks" ref={host}>
    <div className="cs-sidebar-task-scroll" onScroll={() => setMenu(null)}>
      {!!pins.length && group('pinned','置顶',pins)}
      {group('recent','最近任务',recentTasks.filter(t => !t.channel).slice(0,limit),undefined,true)}
      {!folded.recent && recentTasks.filter(t => !t.channel).length > limit && <Button variant="ghost" size="sm" style={{width:'100%',marginTop:"var(--cs-space-2)"}} onClick={() => setLimit(n=>n+12)}>加载更多任务</Button>}
      {channels.map(c => group(`channel-${c}`,c,recentTasks.filter(t => t.channel === c)))}
      {!tasks.length && <div className="cs-task-empty">暂无任务</div>}
      {!!visibleSpaces.length && <section className="cs-task-spaces">
        <button type="button" className="cs-task-section-label" aria-expanded={!spacesCollapsed}
          onClick={() => setSpacesCollapsed(value => !value)}>
          <Icon name={spacesCollapsed ? 'chevronRight' : 'chevronDown'} size={12}/><span>空间</span>
        </button>
        {!spacesCollapsed && visibleSpaces.map(s => group(s.id,s.name,tasks.filter(t => !t.pinned && t.spaceId === s.id),s.id,true))}
      </section>}
    </div>
    {notice && <div className="cs-task-notice" role="status">{notice}</div>}
    {menu && window.ReactDOM.createPortal(<div ref={menuEl} role="menu" aria-label="任务操作" className="cs-task-menu" style={{left:menu.left,top:menu.top}} onKeyDown={e => {
      if (e.isComposing || e.keyCode === 229) return;
      const buttons=[...e.currentTarget.querySelectorAll('button')], i=buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') {setMenu(null);returnFocus.current?.focus();}
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {e.preventDefault();buttons[(i+(e.key === 'ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}
      if (e.key === 'Tab') setMenu(null);
    }}>{[['pin',menu.task.pinned?'取消置顶':'置顶'],['rename','重命名'],['copy','复制任务'],['setSpace',menu.task.spaceId?'移至其他空间':'移入空间'],['merge','合并任务'],['delete','删除任务']].map(([action,label]) =>
      <button key={action} role="menuitem" className={action==='delete'?'is-danger':''} onClick={() => begin(action,menu.task)}>{label}</button>)}</div>,document.body)}
    {modal && <dialog ref={dialog} className="cs-task-dialog" aria-labelledby={dialogTitleId} onCancel={e => {e.preventDefault();closeModal();}} onClick={e => {if(e.target===e.currentTarget)closeModal();}}>
      <h2 id={dialogTitleId}>{({copy:'复制任务？',delete:'删除任务？',merge:'合并任务',setSpace:source.spaceId?'移动任务':'移入空间'})[modal.action]}</h2>
      {modal.action === 'merge' ? <><Input size="md" icon="search" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={e=>setQuery(e.target.value)}/><div className="cs-task-picker">
        {tasks.filter(t=>(t.title||'新任务').includes(query)).map(t=><label key={t.id}><input type="checkbox" checked={chosen.includes(t.id)} onChange={()=>setChosen(ids=>ids.includes(t.id)?ids.filter(id=>id!==t.id):[...ids,t.id])}/><span>{t.title||'新任务'}</span></label>)}
        {!tasks.some(t=>(t.title||'新任务').includes(query)) && <p>没有匹配的任务</p>}
      </div></> : modal.action === 'setSpace' ? <div className="cs-task-picker">
        {groupSpaces.map(s=><Button key={s.id} variant="ghost" onClick={()=>{update(source.id,{spaceId:s.id});setNotice(`已移入${s.name}`);closeModal();}}>{s.name}{source.spaceId===s.id?' · 当前空间':''}</Button>)}
        {!groupSpaces.length && <p>暂无可用空间</p>}
        {source.spaceId && <Button variant="ghost" onClick={()=>{update(source.id,{spaceId:undefined});setNotice('已移出空间');closeModal();}}>移出空间</Button>}
      </div> : <p>{modal.action==='copy'?'复制后将创建独立任务，原任务保留。':`删除「${source.title||'新任务'}」？`}</p>}
      <footer><Button variant="secondary" onClick={closeModal}>取消</Button>{modal.action!=='setSpace' && <Button variant="primary" disabled={modal.action==='merge'&&chosen.length<2} onClick={finish} style={modal.action==='delete'?{background:'var(--cs-critical)',color:'var(--cs-white)'}:{}}>{modal.action==='copy'?'复制任务':modal.action==='delete'?'删除任务':`合并${chosen.length ? ` ${chosen.length} 个任务` : '任务'}`}</Button>}</footer>
    </dialog>}
  </div>;
}

import React from 'react';
import { Button } from '../actions/Button.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Icon } from '../foundation/Icon.jsx';
import { Textarea } from '../forms/Textarea.jsx';
import { Popover } from '../feedback/Popover.jsx';

export function ComposerQueue({ items = [], onChange, initialEditingId = null }) {
  const [editing, setEditing] = React.useState(initialEditingId);
  const [draft, setDraft] = React.useState(items.find(i => i.id === initialEditingId)?.text || '');
  const dragged = React.useRef(null);
  const save = () => {
    onChange?.(draft.trim() ? items.map(i => i.id === editing ? {...i,text:draft.trim()} : i) : items.filter(i => i.id !== editing));
    setEditing(null);
  };
  return <Popover width="100%" title={'排队消息 · ' + items.length} footer="当前回复结束后依次发送。可拖动排序；停止当前回复不暂停队列。">
    <div className="cs-queue-list">
      {!items.length && <p role="status">没有排队消息。执行中按 Enter 可加入队列。</p>}
      {items.map((item, index) => <div key={item.id} className="cs-queue-row" draggable={editing !== item.id}
        onDragStart={() => { dragged.current = item.id; }} onDragEnd={() => { dragged.current = null; }}
        onDragOver={e => e.preventDefault()} onDrop={e => {
          e.preventDefault(); const from = items.findIndex(i => i.id === dragged.current);
          if (from < 0) return; const next = [...items]; next.splice(index, 0, next.splice(from, 1)[0]); onChange?.(next); dragged.current = null;
        }}>
        <span className="cs-state-muted">{index + 1}</span>
        {editing === item.id ? <div className="cs-queue-edit">
          <Textarea aria-label="编辑排队消息" value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }} />
          <div className="cs-state-actions"><Button size="sm" onClick={() => setEditing(null)}>取消编辑</Button>
            <Button size="sm" onClick={save}>保存修改</Button></div>
        </div> : <><span className="cs-queue-text">{item.text}</span>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(item.id); setDraft(item.text); }}>编辑</Button>
          <IconButton size="sm" variant="quiet" title="删除排队消息" onClick={() => onChange?.(items.filter(i => i.id !== item.id))}><Icon name="close" size={12}/></IconButton>
        </>}
      </div>)}
    </div>
  </Popover>;
}

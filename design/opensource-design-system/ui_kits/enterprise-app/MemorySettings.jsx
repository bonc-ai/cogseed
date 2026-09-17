const { Button, Icon, Input, Textarea } = window.CogSeedDesignSystem_f581b5;

// Settings child route: section=data&detail=memory; shares the settings catalog entry.
function MemorySettings({ value, onChange, onBack }) {
  const [transfer,setTransfer] = React.useState(null);
  const [editor, setEditor] = React.useState(null);
  const [deleting, setDeleting] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const trigger = React.useRef(null);
  const total = value.user.length + value.shared.length;
  const sections = [
    { key: 'user', title: '偏好', help: '身份、偏好与沟通风格。' },
    { key: 'shared', title: '全局共享记忆', help: '当前账号的所有对话和智能体共享的长期事实。' },
    { key: 'groups', title: '记忆分组', help: '独立的记忆分组，可在对话输入框通过 @ 选择，作为本轮重点参考。' }
  ];
  const restoreFocus = () => { trigger.current?.focus(); };
  const closeEditor = () => { setEditor(null); restoreFocus(); };
  const edit = (scope, entry, event) => {
    trigger.current = event.currentTarget;
    setDeleting(null);
    setEditor({ scope, id: entry?.id || null, title: entry?.title || '', text: entry?.text || '' });
    setNotice('');
  };
  const save = () => {
    if (!editor?.text.trim() || (editor.scope === 'groups' && !editor.title.trim())) return;
    const entry = { id: editor.id || `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`, text: editor.text.trim(), ...(editor.scope === 'groups' ? {title: editor.title.trim()} : {}) };
    onChange({ ...value, [editor.scope]: editor.id ? value[editor.scope].map(item => item.id === editor.id ? entry : item) : [...value[editor.scope], entry] });
    closeEditor(); setNotice('记忆已保存。');
  };
  const remove = () => {
    onChange({ ...value, [deleting.scope]: value[deleting.scope].filter(item => item.id !== deleting.id) });
    setDeleting(null); setNotice('记忆已删除。');
  };
  const renderEditor = () => <div className="cs-memory-editor" onKeyDown={event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); closeEditor(); }
  }}>
    {editor.scope === 'groups' ? <Input aria-label="分组名称" placeholder="分组名称" value={editor.title} onChange={event => setEditor({...editor,title:event.target.value})} /> : null}
    <Textarea autoFocus aria-label="记忆内容" minHeight={112} placeholder="记录需要在后续任务中保留的信息" value={editor.text} onChange={event => setEditor({...editor,text:event.target.value})} />
    <div className="cs-memory-editor-actions"><span className="cs-settings-muted">{editor.text.length} 字</span><span style={{flex:1}} /><Button onClick={closeEditor}>取消</Button><Button variant="primary" disabled={!editor.text.trim() || (editor.scope === 'groups' && !editor.title.trim())} onClick={save}>保存记忆</Button></div>
  </div>;
  return <>
    <Button variant="ghost" icon={<Icon name="chevronLeft" size={14} />} onClick={onBack} style={{marginBottom:"var(--cs-space-6)",paddingLeft:0}}>返回数据设置</Button>
    <div className="cs-memory-heading">
      <div className="cs-settings-heading"><h1>记忆 <span className="cs-settings-muted">{total} 条</span></h1></div>
      <div className="cs-memory-actions"><Button onClick={() => setTransfer('export')}>导出记忆</Button><Button icon={<Icon name="plus" size={14} />} onClick={() => setTransfer('import')}>导入记忆</Button></div>
    </div>
    <div className="cs-settings-notice" role="status" aria-live="polite">{notice || ''}</div>
    {transfer ? <MemoryTransfer mode={transfer} value={value} onChange={onChange} onClose={() => setTransfer(null)} /> : null}
    {sections.map(scope => <section className="cs-memory-section" key={scope.key}>
      <div className="cs-memory-section-head"><h2>{scope.title}</h2><span className="cs-settings-muted">{value[scope.key].length} {scope.key === 'groups' ? '个' : '条'}</span><span style={{flex:1}} /><Button size="sm" variant="ghost" aria-label={scope.key === 'groups' ? '新建记忆分组' : `新增${scope.title}`} icon={<Icon name="plus" size={14} />} onClick={event => edit(scope.key, null, event)}>{scope.key === 'groups' ? '新建分组' : '新增记忆'}</Button></div>
      <p className="cs-memory-section-help">{scope.help}</p>
      {editor?.scope === scope.key && !editor.id ? renderEditor() : null}
      {!value[scope.key].length && editor?.scope !== scope.key ? <p className="cs-settings-muted">{scope.key === 'groups' ? '暂无分组' : '暂无内容'}</p> : null}
      {value[scope.key].map((entry, index) => editor?.scope === scope.key && editor.id === entry.id ? <React.Fragment key={entry.id}>{renderEditor()}</React.Fragment> : <div className="cs-memory-entry" key={entry.id}>
        <div className="cs-memory-entry-copy">{entry.title ? <h3>{entry.title}</h3> : null}<p>{entry.text}</p></div>
        {deleting?.scope === scope.key && deleting.id === entry.id ? <div className="cs-memory-delete" role="group" aria-label="删除确认"><span>删除这{scope.key === 'groups' ? '个分组' : '条记忆'}？</span><Button size="sm" onClick={() => setDeleting(null)}>取消</Button><Button size="sm" variant="danger" onClick={remove}>删除{scope.key === 'groups' ? '分组' : '记忆'}</Button></div> : <div className="cs-memory-entry-actions"><Button size="sm" variant="ghost" aria-label={`编辑${scope.title}第 ${index + 1} 项`} onClick={event => edit(scope.key, entry, event)}>编辑</Button><Button size="sm" variant="ghost" aria-label={`删除${scope.title}第 ${index + 1} 项`} onClick={() => { setEditor(null); setDeleting({scope:scope.key,id:entry.id}); }}>删除</Button></div>}
      </div>)}
    </section>)}
  </>;
}
Object.assign(window, { MemorySettings });

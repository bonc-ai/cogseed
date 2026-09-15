// Page-only design experiment. State transitions and financial records are local fixtures.
// Source seams: conversation.js task status/queue, chat-side-host.js panes,
// chat-artifact.js outputs, chat-input-form.js user clarification.
const { PageFrame, PageHeader } = window;
const { Icon, Button, IconButton, Tabs, StatusPill, StepList, Alert, DataTable, DateRangePicker, Composer, ComposerAttachments, ComposerQueue, DropdownMenu, EmptyState, Tooltip, Dialog, Field, Input, Select, Checkbox } = window.CogSeedDesignSystem_f581b5;
const TASK_STATES = {
  idle: {label:'未开始',tone:'neutral',line:'尚未开始执行',step:0},
  preparing: {label:'正在思考',tone:'neutral',line:'正在分析任务要求',step:0},
  generating: {label:'正在生成',tone:'neutral',line:'正在生成回答',step:4},
  stopping: {label:'正在停止',tone:'neutral',line:'正在停止当前回复',step:3},
  disabled: {label:'智能体已停用',tone:'neutral',line:'当前智能体已停用，无法发送新消息',step:4},
  running: {label:'运行中',tone:'neutral',line:'正在生成客户经理提醒草稿',step:3},
  waiting: {label:'待你确认',tone:'attention',line:'等待确认缺失项目报告的处理口径',step:2},
  completed: {label:'已完成',tone:'success',line:'本轮任务已完成 · 用时 2分14秒',step:4},
  stopped: {label:'已停止',tone:'neutral',line:'已停止执行，已生成的内容仍然保留',step:3},
  failed: {label:'执行失败',tone:'critical',line:'读取补充项目报告时连接中断',step:2}
};
function TaskScreen({title='项目里程碑与提醒',onBack,collapsed,onExpand,initialState,initialPane='',initialTab=0,content='analysis',agentName='项目助理',workspace,onOpenSpace,initialMessage='',initialReference=''}) {
  const [state,setState]=React.useState(initialState || (content==='empty'?'idle':'running'));
  const [pane,updatePane]=React.useState(initialPane);
  const paneTrigger=React.useRef(null), previousPane=React.useRef(initialPane), mainRef=React.useRef(null);
  const setPane=next=>{if(next&&!pane)paneTrigger.current=document.activeElement;updatePane(next);};
  React.useEffect(()=>{
    if(previousPane.current&&!pane){const target=paneTrigger.current; if(target?.isConnected)target.focus();else mainRef.current?.querySelector('[aria-label="任务详情"]')?.focus();}
    if(previousPane.current!==pane&&pane)mainRef.current?.parentElement?.querySelector('.rd-side button')?.focus();
    previousPane.current=pane;
  },[pane]);
  const [attachments,setAttachments]=React.useState(content==='attachment'?[{id:'draft',name:'项目资料截图.png',size:'248 KB',status:'ready'}]:[]);
  const [queue,setQueue]=React.useState(content==='queue'?[{id:'q1',text:'补充项目组汇总口径。'}]:[]);
  const [reference,setReference]=React.useState(initialReference);
  const [terminal,setTerminal]=React.useState(content==='terminal');
  const [txt,setTxt]=React.useState('');
  const [effort,setEffort]=React.useState('自动');
  const [messages,setMessages]=React.useState(content==='empty'&&initialMessage?[initialMessage]:[]);
  const [notice,setNotice]=React.useState('');
  const [sortKey,setSortKey]=React.useState('due');
  const [dir,setDir]=React.useState(1);
  const end=React.useRef(null);
  const status=TASK_STATES[state] || TASK_STATES.completed;
  const taskWorkspace=workspace===undefined?{id:'credit',name:'产品研发'}:workspace;
  const workspacePath=`工作空间 / 我的空间 / ${taskWorkspace?.name || '默认工作区'}`;
  const simple=content!=='analysis' && content!=='queue';
  const completed=state==='completed'||state==='disabled';
  const active=['preparing','running','generating'].includes(state);
  const changeState=value=>{setState(value);setNotice('');};
  const send=()=>{if(!txt.trim()&&!attachments.length&&!reference)return;setAttachments([]);setReference('');setMessages(v=>[...v,txt.trim()||'已补充附件或引用']);setTxt('');changeState('running');};
  React.useEffect(()=>{if(messages.length)end.current?.scrollIntoView({block:'nearest'});},[messages]);
  const rows=[...window.ROWS].sort((a,b)=>(sortKey==='due'?a.due.localeCompare(b.due):Number(a.amt.replaceAll(',',''))-Number(b.amt.replaceAll(',','')))*dir);
  const steps=['读取项目台账 · 1,842 条','筛选到期记录 · 137 条','核对项目组与项目报告口径','生成客户经理提醒草稿'];
  const artifact=<div className="rd-artifact"><div className="rd-row"><Icon name="file" size={20}/><div className="rd-grow"><strong>60天内到期项目清单</strong><small>137 条记录 · {completed?'本轮产物':'阶段产物'}</small></div><StatusPill tone={completed?'success':'neutral'}>{completed?'已生成':'可预览'}</StatusPill></div><div className="rd-artifact-actions"><Button size="sm" onClick={()=>setPane('artifact')}>查看产物<Icon name="chevronRight" size={13}/></Button></div></div>;
  return <PageFrame className="rd-task" style={{minWidth:"var(--rd-task-min-width, 0px)"}}>
    <div className="rd-main" ref={mainRef}>
      <PageHeader className="rd-task-header" collapsed={collapsed} onExpand={onExpand} title={title}
        leading={<>{onBack&&<IconButton variant="quiet" size="sm" title="返回上一页" onClick={onBack}><Icon name="chevronLeft" size={15}/></IconButton>}{taskWorkspace&&<nav className="rd-breadcrumb" aria-label={workspacePath} title={workspacePath}><Button size="sm" variant="ghost" aria-label="工作空间" onClick={()=>onOpenSpace?onOpenSpace(taskWorkspace):setNotice('当前工作空间：'+taskWorkspace.name)}><span className="rd-path-full">工作空间</span><span className="rd-path-short" aria-hidden="true">…</span></Button><span aria-hidden="true">/</span><Button size="sm" variant="ghost" onClick={()=>onOpenSpace?onOpenSpace(taskWorkspace):setPane('info')}>{taskWorkspace.name}</Button><span aria-hidden="true">/</span></nav>}</>}
        status={<><StatusPill tone={status.tone}>{status.label}</StatusPill><span className="rd-muted rd-participants">{content==='empty'?'1 个智能体 · '+agentName:'3 个智能体'}</span></>}
        actions={<><IconButton variant="quiet" size="sm" title="终端" active={terminal} onClick={()=>setTerminal(v=>!v)}><Icon name="terminal" size={16}/></IconButton><IconButton variant="quiet" size="sm" title="Agent 状态" active={pane==='info'} onClick={()=>setPane('info')}><Icon name="info" size={16}/></IconButton><DropdownMenu trigger={<IconButton variant="quiet" size="sm" title="更多任务操作" aria-label="更多任务操作"><Icon name="dots" size={16}/></IconButton>} groups={[{items:['置顶','重命名','复制会话','移至其他空间','选择并合并'].map(label=>({label,onSelect:()=>setNotice('已选择「'+label+'」')}))},{danger:true,items:[{label:'删除',onSelect:()=>setNotice('任务尚未删除。')}]}]}/><IconButton variant="quiet" size="sm" title="任务详情" active={!!pane} aria-label="任务详情" onClick={()=>setPane(pane?'':'info')}><Icon name="sidebar" size={16}/></IconButton></>} />
      <div className="rd-thread" data-cs-scroll>
        <div className="rd-thread-inner">
          {simple?(content==='empty'&&messages.length?null:<TaskConversation content={content} agentName={agentName} onNotice={setNotice} onEdit={text=>{setTxt(text);setNotice('正在编辑消息，修改后可重新发送。');}} onReference={setReference} onSide={()=>setPane('followup')} onAttach={()=>setAttachments([{id:'added',name:'会议记录.txt',size:'24 KB',status:'ready'}])}/>):<>
          <div className="rd-date">今天</div>
          <article className="rd-user"><div className="rd-user-body">整理未来60天内到期的项目项目，按项目组汇总预算，并生成客户经理提醒草稿。缺少最新项目报告的客户单独标出来。</div><div className="rd-file"><Icon name="file" size={16}/><span>项目台账_2026Q3.xlsx</span><small>128 KB</small></div><time className="rd-message-time" dateTime="14:02">14:02</time><TaskMessageActions user text="整理未来60天内到期的项目项目，按项目组汇总预算，并生成客户经理提醒草稿。缺少最新项目报告的客户单独标出来。" onNotice={setNotice} onReference={setReference} onSide={()=>setPane('followup')}/></article>
          <article className="rd-answer"><div className="rd-author"><span className="rd-agent-mark"><Icon name="fileCheck" size={15}/></span>{agentName}<small className="rd-muted">DeepSeek V4 Flash · 自动 · 14:03</small></div>
            {state==='preparing'?<p className="rd-thinking"><Icon name="loader" size={15}/>正在分析任务要求…</p>:<p>已读取台账中的1,842条记录，将按到期日筛选，并核对项目组归属与项目报告口径。</p>}
            {state!=='preparing'&&<details className="rd-process" open={state==='running'}><summary><Icon name="automation" size={15}/><span>过程信息</span><small>{status.step}/4 步完成</small><Icon name="chevronDown" size={13}/></summary><p className="rd-muted">总耗时 2分14秒 · 模型 6.6秒 · 首 token 1.1秒</p><StepList steps={steps.map((label,i)=>({label,state:i<status.step?'done':i===status.step&&state==='running'?'running':'wait',meta:i<status.step?'已完成':i===status.step?status.label:'待执行'}))}/></details>}
            {state!=='preparing'&&<div className="rd-result"><h2>{completed?'到期项目清单已整理':'已筛出137条到期项目'}</h2><p>涉及9家项目组。统计口径为本金余额，不含表外；其中3户缺少最新项目报告，已单独标记为待核。</p><div className="rd-facts"><div><strong>137<span> 条</span></strong><small>60天内到期</small></div><div><strong>9<span> 家</span></strong><small>涉及项目组</small></div><div><strong>3<span> 户</span></strong><small>项目报告待补充</small></div></div>{artifact}</div>}
            {state==='waiting'&&<div className="rd-confirm"><strong>缺少最新项目报告的3户，如何处理？</strong><p>请选择本轮分析的口径。</p><div className="rd-row"><Button variant="ink" onClick={()=>{changeState('running');setNotice('已采用上期项目报告，3户保留待核标记。');}}>采用上期并标记待核</Button><Button onClick={()=>{changeState('running');setNotice('本轮暂不纳入这3户，正在重新汇总。');}}>暂不纳入汇总</Button></div></div>}
            {state==='failed'&&<Alert tone="critical" title="补充项目报告读取中断" >已保留台账筛选结果，重新尝试后继续核对。<div style={{marginTop:"var(--cs-space-2)"}}><Button size="sm" onClick={()=>changeState('running')}>重新尝试</Button></div></Alert>}
            {completed&&<p>已生成提醒草稿，尚未发送。可先查看产物，再调整提醒内容。</p>}
            {state==='generating'&&<p className="rd-stream-text">建议优先联系未来30天内到期的客户，并对缺失项目报告的3户补充材料后再复核。提醒草稿将按项目组分别整理<span className="rd-caret" aria-hidden="true"/></p>}
            <div className="rd-runline" role="status"><span className={active?'rd-live':''}><Icon name={completed?'check':state==='failed'?'alert':'clock'} size={14}/></span>{status.line}{state==='running'&&<span className="rd-elapsed">已用 1分42秒</span>}{state==='stopped'&&<Button size="sm" variant="ghost" onClick={()=>changeState('running')}>继续执行</Button>}</div>
            <time className="rd-message-time" dateTime="14:03">14:03</time>
          <TaskMessageActions text="已筛出137条到期项目" onNotice={setNotice} onEdit={text=>{setTxt(text);setNotice('正在编辑消息，修改后可重新发送。');}} onReference={setReference} onSide={()=>setPane('followup')}/></article></>}
          {messages.map((text,i)=><article className="rd-user" key={i}><div className="rd-user-body">{text}</div><TaskUserTime time="刚刚" onEdit={()=>setTxt(text)}/><TaskMessageActions user text={text} onNotice={setNotice} onReference={setReference} onSide={()=>setPane('followup')}/></article>)}
          {content!=='empty'&&<Button size="sm" variant="ghost" onClick={()=>{setPane('distill');}}>把以上对话沉淀为智能体</Button>}
          <div ref={end}/>
        </div>
      </div>
      <div className="rd-composer-wrap"><div className="rd-composer-inner">{notice&&<div role="status" className="rd-notice">{notice}</div>}<Composer spaceBound={!!taskWorkspace} spaceOptions={taskWorkspace?[taskWorkspace]:[]} spaceId={taskWorkspace?.id || ''} contextTags={[{label:'@ '+agentName,selected:true}]} modelName="DeepSeek V4 Flash" providerName="DeepSeek" beforeInput={<>{queue.length>0&&<ComposerQueue items={queue} onChange={setQueue}/>}{attachments.length>0&&<ComposerAttachments items={attachments} onRemove={id=>setAttachments(v=>v.filter(a=>a.id!==id))}/>}{reference&&<div className="rd-reference"><span>引用 · {reference}</span><IconButton size="sm" aria-label="取消引用" onClick={()=>setReference('')}><Icon name="close" size={12}/></IconButton></div>}</>} onAttach={()=>setAttachments(v=>v.concat({id:String(Date.now()),name:'补充材料.pdf',size:'128 KB',status:'ready'}))} sendAllowed={!!(txt.trim()||attachments.length||reference)} reasoningEffort={effort} onReasoningEffortChange={setEffort} placement="conversation" width="100%" value={txt} onChange={setTxt} inputDisabled={state==='disabled'} phase={state==='stopping'?'stopping':active?'running':'idle'} onStop={()=>changeState('stopped')} onQueue={()=>{if(attachments.length){setNotice('带附件的消息暂不支持排队，请等待本轮结束。');return;}if(txt.trim()){setQueue(v=>[...v,{id:String(Date.now()),text:txt.trim()}]);setTxt('');}}} onSend={send} placeholder={state==='disabled'?'当前智能体已停用，无法发送消息':'输入 @ 选择智能体、技能、产物、资产'}/>{content!=='empty'&&<div className="rd-metrics">{content==='conversation'?'2 轮 · 0 步':simple?'1 轮 · 0 步':'1 轮 · 4 步'}<span>LLM 6.6s</span><span>首 token 1.1s</span><span>缓存 49%</span><span>上下文 579</span><span>Token ↑122K ↓458</span></div>}</div></div>
      {terminal&&<section className="rd-terminal" aria-label="终端"><div className="rd-row"><strong className="rd-grow">shell</strong><Button size="sm" variant="ghost" onClick={()=>setNotice('已新建终端标签')}>新建终端</Button><IconButton size="sm" aria-label="关闭终端" onClick={()=>setTerminal(false)}><Icon name="close" size={14}/></IconButton></div><pre>shell 已就绪</pre></section>}
    </div>
    {['followup','distill'].includes(pane)?<TaskAuxPane pane={pane} onClose={()=>setPane('')}/>:pane&&<TaskContextPane pane={pane} onPane={setPane} onClose={()=>setPane('')} title={title} empty={content==='empty'} agentName={agentName} runCount={content==='empty'?0:content==='conversation'?2:1} conversation={content==='conversation'} status={status} completed={completed} preparing={state==='preparing'} initialTab={initialTab} rows={rows} sortKey={sortKey} dir={dir} onSort={key=>{setSortKey(key);setDir(key===sortKey?-dir:1);}}/>}
  </PageFrame>;
}
// Mirrors conversation-info.js::_renderRunContext, not an invented task dashboard.
// File viewing is a separate surface in production (chat-side-host / file viewer).
function TaskContextPane({pane,onPane,onClose,title,empty=false,agentName,runCount=1,conversation=false,status,completed,preparing,initialTab,rows,sortKey,dir,onSort}){
  const closeOnEscape=e=>{if(e.key!=='Escape'||e.defaultPrevented||e.isComposing||e.keyCode===229||e.target.closest('[role="dialog"],[role="listbox"],[role="menu"]'))return;e.preventDefault();e.stopPropagation();onClose();};
  const [tab,setTab]=React.useState(initialTab);
  const [file,setFile]=React.useState('60天内到期项目清单.csv');
  if(empty)return <aside className="rd-side" onKeyDown={closeOnEscape} aria-label="任务详情"><div className="rd-side-head"><span>任务详情</span><IconButton aria-label="关闭侧栏" size="sm" onClick={onClose}><Icon name="close" size={14}/></IconButton></div><div className="rd-side-body"><strong>{title}</strong><p>{agentName} · {status.label}</p><EmptyState title="本会话暂无执行记录" reason="执行后在这里查看运行记录与产物。"/></div></aside>;
  const openFile=name=>{setFile(name);onPane('artifact');};
  const fileRow=(name,meta)=><div className="rd-context-file" key={name}><Icon name="fileText" size={16}/><div className="rd-grow"><Button variant="ghost" size="sm" style={{padding:0,maxWidth:'100%',justifyContent:'flex-start'}} onClick={()=>openFile(name)}>{name}</Button><small>{meta}</small></div></div>;
  return <aside className="rd-side" onKeyDown={closeOnEscape} aria-label={pane==='artifact'?'文件预览':'任务详情'}>
    <div className="rd-side-head"><span>{pane==='artifact'?'文件预览':'任务详情'}</span><IconButton variant="quiet" size="sm" aria-label="关闭侧栏" onClick={onClose}><Icon name="close" size={14}/></IconButton></div>
    {pane==='info'&&<div className="rd-context-tabs"><Tabs items={['本次运行','来源与产物','运行与协作','四类资产']} value={tab} onChange={setTab} style={{gap:"var(--cs-space-2)",justifyContent:'space-between'}}/></div>}
    <div className="rd-side-body" data-cs-scroll>
      {pane==='artifact'?<><Button size="sm" variant="ghost" onClick={()=>{onPane('info');setTab(1);}}><Icon name="chevronLeft" size={13}/>返回来源与产物</Button><h3 style={{marginTop:"var(--cs-space-4)"}}>{file}</h3>{file.endsWith('.csv')?<TaskArtifactTable rows={rows} sortKey={sortKey} dir={dir} onSort={onSort}/>:file.endsWith('.md')?<p className="rd-muted">请核对名下未来60天内到期的项目，并跟进缺失项目报告的补充情况。</p>:<p className="rd-muted">项目台账_2026Q3.xlsx · 128 KB</p>}</>:<>
      {tab===0&&<>{preparing?<p className="rd-muted">本会话暂无执行记录。</p>:<><p className="rd-run-count">共 {runCount} 次运行</p><div className="rd-run-list">{Array.from({length:runCount},(_,i)=><div key={i} className="rd-context-run"><div className="rd-row"><span className="rd-run-number">{runCount-i}</span><strong className="rd-grow">{agentName}</strong><StatusPill tone={status.tone}>{status.label}</StatusPill></div><div className="rd-run-meta"><span>{i===0?'最近一次':'此前运行'}</span><time>{conversation?(i===0?'11:48':'11:46'):'14:03'}</time></div><div className="rd-run-meta"><span>请求批准</span><span>{conversation?'无文件产物':completed?'2 个产物':'阶段产物'}</span></div></div>)}</div></>}<dl className="rd-run-fields"><dt>执行方</dt><dd>{agentName}</dd><dt>边界</dt><dd>真实</dd><dt>权限</dt><dd>请求批准</dd></dl><p className="rd-run-note"><Icon name="shield" size={14}/>本会话最近一次执行的权限模式：请求批准</p></>}
      {tab===1&&<><dl><dt>来源</dt><dd>{title}</dd></dl><section><h3>工作区</h3><p className="rd-muted">暂无工作区文件</p></section><section><h3>产出 <span>{preparing||conversation?0:completed?2:1}</span></h3>{preparing||conversation?<p className="rd-muted">暂无产出文件</p>:fileRow('60天内到期项目清单.csv','产出')}{completed&&!conversation&&fileRow('客户经理提醒草稿.md','产出')}</section><section><h3>附件 <span>{conversation?0:1}</span></h3>{conversation?<p className="rd-muted">暂无附件</p>:fileRow('项目台账_2026Q3.xlsx','128 KB')}</section></>}
      {tab===2&&<><section><h3>运行证明</h3><p className="rd-muted">暂无 P3394 协议事件。</p></section><section><h3>协作参与者</h3><p className="rd-muted">当前还没有活跃协作。</p></section></>}
      {tab===3&&<><div className="rd-context-assets">{['关于我','规则与偏好','模板与范例','技能与方法'].map(label=><div key={label}><span>{label}</span><strong>0</strong></div>)}</div><p className="rd-muted">本会话暂无认知沉淀。</p></>}
      </>}
    </div>
  </aside>;
}
// The preview contains three supplied records; filters never claim to query the full ledger.
function TaskArtifactTable({rows=[],sortKey,dir,onSort}){
  const filterRef=React.useRef(null);
  const [range,setRange]=React.useState({start:'',end:''});
  const filtered=rows.filter(row=>(!range.start||row.due>=range.start)&&(!range.end||row.due<=range.end));
  return <section ref={filterRef} aria-label="到期日筛选与记录">
    <DateRangePicker value={range} onChange={setRange} presets={[]}/>
    <p role="status" className="rd-muted">显示 {filtered.length} / {rows.length} 条已载入记录</p>
    {filtered.length?<DataTable label="到期项目记录" sortKey={sortKey} sortDir={dir} onSort={onSort} columns={[{key:'name',label:'客户名称',primary:true},{key:'due',label:'到期日',sortable:true},{key:'amt',label:'预算/万',align:'right',sortable:true}]} rows={filtered}/>:<EmptyState title="该日期范围内没有记录" action="清空日期" onAction={()=>{setRange({start:'',end:''});filterRef.current?.querySelector('input')?.focus();}}/>}
  </section>;
}
// Content fixtures are rewritten for financial work; no private client messages are copied.
function TaskUserTime({time,onEdit}){
  return <div className="rd-user-meta"><time className="rd-message-time">{time}</time><span className="rd-user-edit"><Tooltip label="编辑这条消息"><IconButton variant="quiet" size="sm" aria-label="编辑这条消息" onClick={onEdit}><Icon name="pencil" size={14}/></IconButton></Tooltip></span></div>;
}
function TaskMessageActions({text,onNotice,onReference,onSide,onEdit,user=false}){
  const [selected,setSelected]=React.useState(false);
  const [action,setAction]=React.useState('');
  const [name,setName]=React.useState('');
  const [category,setCategory]=React.useState('规则与偏好');
  const [saved,setSaved]=React.useState('');
  const openAction=kind=>{setName(text.slice(0,20));setAction(kind);};
  const iconAction=(icon,label,handler)=><Tooltip label={label}><IconButton variant="quiet" size="sm" aria-label={label} onClick={handler}><Icon name={icon} size={16}/></IconButton></Tooltip>;
  return <>
    <div className="rd-message-actions">
      {iconAction('copy','复制此消息到剪贴板',async()=>{try{await navigator.clipboard.writeText(text);onNotice('已复制消息');}catch{onNotice('复制未完成，请选择正文后复制。');}})}
      {iconAction('atSign','引用此消息发送给目标智能体',()=>onReference(text))}
      {iconAction('messageSquare','在侧栏追问这条消息',onSide)}
      <DropdownMenu side="top" trigger={<IconButton variant="quiet" size="sm" title="更多消息操作" aria-label="更多消息操作"><Icon name="dots" size={16}/></IconButton>} groups={[{items:[{label:'选择',icon:'list',onSelect:()=>setSelected(true)},...(!user?[{label:'沉淀为认知',icon:'brain',onSelect:()=>openAction('cognition')},{label:'资料库',icon:'bookOpen',onSelect:()=>openAction('library')}]:[])]}]}/>
    </div>
    {selected&&<div className="rd-message-selection"><Checkbox checked={selected} label="已选择这条消息" onChange={setSelected}/><Button size="sm" variant="ghost" onClick={()=>{onReference(text);setSelected(false);}}>引用所选消息</Button><Button size="sm" variant="ghost" onClick={()=>setSelected(false)}>取消选择</Button></div>}
    {saved&&<p className="rd-muted" role="status">{saved}</p>}
    {action&&<Dialog title={action==='cognition'?'将这条消息沉淀为认知？':'将这条消息存入资料库？'} description="保留原始消息，整理内容的名称与归属。" confirmLabel={action==='cognition'?'生成候选':'保存草稿'} onCancel={()=>setAction('')} onConfirm={()=>{if(!name.trim())return;setSaved(action==='cognition'?'认知候选草稿：'+name+' · '+category:'资料库条目草稿：'+name);setAction('');}} extra={<div className="rd-message-form"><Field label={action==='cognition'?'认知名称':'文件名称'}><Input aria-label={action==='cognition'?'认知名称':'文件名称'} value={name} onChange={e=>setName(e.target.value)}/></Field>{action==='cognition'?<Field label="认知分类"><Select aria-label="认知分类" options={['关于我','规则与偏好','模板与范例','技能与方法']} value={category} onChange={setCategory}/></Field>:<Field label="保存位置"><Input aria-label="保存位置" value="资料库" readOnly/></Field>}<p className="rd-message-excerpt">{text}</p>{!name.trim()&&<p role="alert">请填写名称</p>}</div>}/>}
  </>;
}
function TaskConversation({content,agentName,onNotice,onReference,onSide,onEdit,onAttach}){
  const [feedback,setFeedback]=React.useState('');
  const [continued,setContinued]=React.useState(false);
  if(content==='empty')return <EmptyState title="无对话记录" reason="描述一项工作，开始这段对话。"/>;
  const missing=content==='missing';
  const branch=content==='branch';
  const prompt=missing?'从附件中提取每个成员提出的问题，先分列再汇总。':branch?'继续这项工作。先说明当前进度、约束和下一步。':'如何整理本周客户访谈中的需求？';
  const answer=missing?'当前工作空间未检测到附件，暂时无法提取。补充会议记录后，将按成员分列问题，合并同类项，并标注说话人不明的内容。':'可以按“原始反馈 → 问题主题 → 优先级 → 验收标准”整理。保留每条需求的来源和待确认项，先形成可评审草稿。';
  return <><div className="rd-date">2026年9月5日</div><article className="rd-user"><TaskUserTime time="11:46" onEdit={()=>onEdit?.(prompt)}/><div className="rd-user-body">{prompt}</div>{missing&&<div className="rd-file"><Icon name="file" size={15}/>客户访谈会议记录.txt</div>}<TaskMessageActions user text={prompt} {...{onNotice,onReference,onSide,onEdit}}/></article>
    <article className="rd-answer"><div className="rd-author"><span className="rd-agent-mark"><Icon name="fileCheck" size={15}/></span>{agentName}<small className="rd-muted">DeepSeek V4 Flash · 自动 · 11:46</small></div>
      <div className="rd-answer-card"><details className="rd-process" open={content==='process'}><summary><Icon name="chevronRight" size={13}/><span>过程信息</span><small>{branch?'2分7秒':'3秒'}</small></summary><p className="rd-muted">总耗时 3秒 · 模型 2秒</p><div className="rd-metrics">用时 2.1s · 首 token 1s · Token ↑30.5K ↓168</div></details>
      {branch?<><strong>继续整理项目到期清单</strong><p>工作空间可用能力：关于我 1项 · 我的能力 6项</p><h3>建议 Action Plan</h3><ol><li>核验台账版本，筛选未来60天内到期记录。</li><li>保留3户项目报告待核标记，生成提醒草稿。</li></ol><p>只对目标任务生效</p><div className="rd-row"><Button size="sm" onClick={()=>onNotice('依据：上一任务的筛选结果与待核口径。')}>查看依据</Button><Button size="sm" variant="ink" disabled={continued} onClick={()=>setContinued(true)}>{continued?'已携带上下文':'带着这些继续'}</Button></div>{continued&&<p role="status">已携带计划和约束，准备继续核验。</p>}</>:<><p>{answer}</p>{missing?<Button size="sm" onClick={onAttach}>补充附件</Button>:<><ul><li>需求证据：原话、来源、日期与涉及角色。</li><li>问题主题：使用场景、影响范围与待核实内容。</li><li>交付评审：优先级、验收标准与下一步。</li></ul><div className="rd-memory"><strong>提供给本次回答的记忆</strong><p>我的习惯 <small>事实与偏好 · 个人</small></p><div className="rd-row">{['有帮助','需改进'].map(label=><Button key={label} size="sm" aria-pressed={feedback===label} onClick={()=>setFeedback(label)}>{label}</Button>)}{feedback&&<span role="status">已记录：{feedback}</span>}</div></div></>}</>}
      </div><TaskMessageActions text={answer} {...{onNotice,onReference,onSide,onEdit}}/>
    </article>
    {content==='conversation'&&<><article className="rd-user"><TaskUserTime time="11:48" onEdit={()=>onEdit?.('先给出一个整理模板。')}/><div className="rd-user-body">先给出一个整理模板。</div><TaskMessageActions user text="先给出一个整理模板。" {...{onNotice,onReference,onSide,onEdit}}/></article><article className="rd-answer"><div className="rd-author"><span className="rd-agent-mark"><Icon name="fileCheck" size={15}/></span>{agentName}<small className="rd-muted">DeepSeek V4 Flash · 自动 · 11:48</small></div><div className="rd-answer-card"><p>建议使用以下列名，未确认的信息标记为待核。</p><DataTable columns={[{key:'field',label:'字段'},{key:'value',label:'填写说明'}]} rows={[{field:'原始反馈',value:'保留原话和访谈来源'},{field:'问题主题',value:'按场景归并，避免过早合并'},{field:'待确认项',value:'写明缺口与责任人'}]}/></div><TaskMessageActions text="原始反馈、问题主题、待确认项" {...{onNotice,onReference,onSide,onEdit}}/></article></>}
  </>;
}
function TaskAuxPane({pane,onClose}){
  const [draft,setDraft]=React.useState('');
  const [answer,setAnswer]=React.useState('');
  return <aside className="rd-side" aria-label={pane==='followup'?'侧栏追问':'沉淀为智能体'}><div className="rd-side-head"><strong>{pane==='followup'?'侧栏追问':'沉淀为智能体'}</strong><IconButton aria-label="关闭侧栏" size="sm" onClick={onClose}><Icon name="close" size={14}/></IconButton></div><div className="rd-side-body"><blockquote>当前消息 · 保留需求来源和待确认项</blockquote>{pane==='followup'?<><p>围绕这条消息继续提问。</p><window.CogSeedDesignSystem_f581b5.Field label="追问内容"><window.CogSeedDesignSystem_f581b5.Input value={draft} onChange={e=>setDraft(e.target.value)}/></window.CogSeedDesignSystem_f581b5.Field><Button size="sm" disabled={!draft.trim()} onClick={()=>setAnswer('可补充访谈时间、原始记录位置与待核责任人。')}>发送追问</Button>{answer&&<p role="status">{answer}</p>}</>:<><p>将任务中的角色、约束和工作方法整理为智能体草稿。</p><Button size="sm" onClick={()=>setAnswer('智能体草稿已整理，可继续补充名称和说明。')}>生成草稿</Button>{answer&&<p role="status">{answer}</p>}</>}</div></aside>;
}
// Review navigation stays outside product frames. Scene and view are stable URL parameters.
const TASK_SCENES = [
  {id:'conversation',label:'普通多轮与记忆',group:'对话内容',content:'conversation'},
  {id:'empty',label:'空对话',group:'对话内容',content:'empty'},
  {id:'process',label:'过程与用量展开',group:'对话内容',content:'process'},
  {id:'attachment',label:'待发送附件',group:'对话内容',content:'attachment'},
  {id:'missing',label:'附件缺失',group:'对话内容',state:'waiting',content:'missing'},
  {id:'branch',label:'分支续接与计划',group:'对话内容',state:'waiting',content:'branch'},
  ...[['preparing','等待首段回复'],['running','执行步骤'],['generating','生成回答'],['waiting','等待用户补充'],['completed','本轮完成'],['stopping','停止中'],['stopped','已停止'],['failed','执行失败'],['disabled','智能体停用']].map(([id,label])=>({id,label,group:'执行状态',state:id})),
  {id:'queue',label:'执行中排队',group:'执行状态',state:'running',content:'queue'},
  ...['本次运行','来源与产物','运行与协作','四类资产'].map((label,tab)=>({id:'detail-'+tab,label,group:'详情面板',pane:'info',tab,content:tab===0?'conversation':'analysis'})),
  {id:'artifact',label:'文件预览',group:'详情面板',pane:'artifact'},
  {id:'followup',label:'侧栏追问',group:'详情面板',pane:'followup',content:'conversation'},
  {id:'distill',label:'沉淀智能体',group:'详情面板',pane:'distill',content:'conversation'},
  {id:'terminal',label:'终端展开',group:'详情面板',content:'terminal'}
];
function TaskStateSheet(){
  const read=()=>{const q=new URLSearchParams(location.search);return {id:TASK_SCENES.some(s=>s.id===q.get('scene'))?q.get('scene'):'conversation',all:q.get('view')==='all'};};
  const [selection,setSelection]=React.useState(read);
  React.useEffect(()=>{const sync=()=>setSelection(read());window.addEventListener('popstate',sync);return()=>window.removeEventListener('popstate',sync);},[]);
  const choose=(id,all=selection.all)=>{setSelection({id,all});const url=new URL(location.href);url.searchParams.set('scene',id);if(all)url.searchParams.set('view','all');else url.searchParams.delete('view');history.pushState(null,'',url);if(all)requestAnimationFrame(()=>document.getElementById('scene-'+id)?.scrollIntoView({block:'start'}));};
  const index=TASK_SCENES.findIndex(s=>s.id===selection.id);
  return <div className="rd-review"><aside className="rd-scene-nav" aria-label="对话详情样例导航"><h1>对话详情</h1>{['对话内容','执行状态','详情面板'].map(group=><section key={group}><h2>{group}</h2>{TASK_SCENES.filter(s=>s.group===group).map(s=><Button key={s.id} size="sm" variant="ghost" aria-current={s.id===selection.id?'page':undefined} onClick={()=>choose(s.id)}>{s.label}</Button>)}</section>)}</aside><div className="rd-review-main"><header className="rd-review-toolbar"><span>{index+1} / {TASK_SCENES.length} · {TASK_SCENES[index].label}</span><div className="rd-row"><Button size="sm" disabled={index===0} onClick={()=>choose(TASK_SCENES[index-1].id)}>上一页</Button><Button size="sm" disabled={index===TASK_SCENES.length-1} onClick={()=>choose(TASK_SCENES[index+1].id)}>下一页</Button><Button size="sm" aria-pressed={selection.all} onClick={()=>choose(selection.id,!selection.all)}>{selection.all?'单页浏览':'全部平铺'}</Button></div></header><div className={'rd-state-sheet'+(selection.all?'':' rd-single')} data-cs-scroll>{(selection.all?TASK_SCENES:[TASK_SCENES[index]]).map(scene=><section className="rd-state-section" key={scene.id} id={'scene-'+scene.id} aria-label={scene.label}>{selection.all&&<h1>{scene.label}</h1>}<div className="rd-state-frame"><TaskScreen initialState={scene.content==='empty'?'idle':scene.state||'completed'} initialPane={scene.pane||''} initialTab={scene.tab||0} content={scene.content||'analysis'} title={scene.content==='empty'?'新对话':scene.content==='branch'?'续接 · 项目到期清单':scene.content==='missing'?'从附件中提取成员问题':scene.content?'客户访谈需求整理':'项目里程碑与提醒'}/></div></section>)}</div></div></div>;
}
Object.assign(window,{TaskScreen,TaskStateSheet});

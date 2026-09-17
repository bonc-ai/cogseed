/* Installed automation interaction reference: src/renderer/modules/auto.js.
 * Preview state is in memory; file selections retain metadata only. */
const { PageFrame, PageHeader, PageScroll, AutomationSchedule: Schedule } = window;
const { ResourceCard, CardGrid, GroupHeading, StatusDot, EmptyState, Button, Icon, Dialog, Composer, Field, Input, Select, Checkbox } = window.CogSeedDesignSystem_f581b5;
const AUTOMATION_TEMPLATES = [
  {
    "id": "tech_news",
    "icon": "fileText",
    "title": "科技早报",
    "description": "早晨汇总科技、AI 和产品动态，筛出适合办公人群快速浏览的重点。",
    "message": "汇总过去 24 小时科技、AI 和产品领域的重要动态，按主题分组，每条附一句要点和来源，输出适合快速浏览的简报。",
    "schedule": {
      "type": "daily",
      "hour": 8,
      "minute": 30,
      "weekday": 5,
      "day": 25
    }
  },
  {
    "id": "daily_wrapup",
    "icon": "file",
    "title": "每日工作收尾",
    "description": "下班前整理当天进展、风险和明日待办，适合个人复盘或团队同步。",
    "message": "帮我整理今天的工作收尾：列出今日主要进展、遇到的风险或阻塞、以及明天需要优先处理的待办事项。",
    "schedule": {
      "type": "daily",
      "hour": 18,
      "minute": 0,
      "weekday": 5,
      "day": 25
    }
  },
  {
    "id": "meeting_prep",
    "icon": "calendar",
    "title": "会议准备",
    "description": "每天开始前梳理会议目标、待确认问题和需要提前准备的材料。",
    "message": "帮我准备今天的会议：梳理会议目标、需要确认的关键问题清单，以及应提前准备的材料和数据。",
    "schedule": {
      "type": "daily",
      "hour": 8,
      "minute": 45,
      "weekday": 5,
      "day": 25
    }
  },
  {
    "id": "weekly_report",
    "icon": "file",
    "title": "周报草稿",
    "description": "每周五生成一份结构化周报草稿，减少临下班补材料的成本。",
    "message": "帮我生成本周周报草稿，按「本周完成」「进行中」「下周计划」「风险与需要支持」四部分组织，保持简洁的要点式表达。",
    "schedule": {
      "type": "weekly",
      "hour": 17,
      "minute": 30,
      "weekday": 5,
      "day": 25
    }
  },
  {
    "id": "project_health",
    "icon": "automation",
    "title": "项目健康巡检",
    "description": "定期检查项目状态、近期变更和潜在风险，适合研发或运营项目。",
    "message": "对当前项目做一次健康巡检：概述整体状态、近期关键变更、潜在风险点，并给出建议的处理优先级。",
    "schedule": {
      "type": "daily",
      "hour": 10,
      "minute": 0,
      "weekday": 5,
      "day": 25
    }
  },
  {
    "id": "monthly_admin",
    "icon": "calendar",
    "title": "月度行政提醒",
    "description": "月底前提醒整理发票、报销、续费、合同和常规行政待办。",
    "message": "帮我梳理本月的行政待办清单：发票、报销、订阅续费、合同到期等需要在月底前处理的事项，并按紧急程度排序。",
    "schedule": {
      "type": "monthly",
      "hour": 10,
      "minute": 0,
      "weekday": 5,
      "day": 25
    }
  }
];
const AUTOMATION_REFERENCES = [
  {id:'cogseed',kind:'agent',name:'cogseed',description:'默认智能体'},
  {id:'research',kind:'skill',name:'深度研究',description:'查找并整理主题资料'},
  {id:'calendar',kind:'connector',name:'日历',description:'会议与日程'},
  {id:'report',kind:'library',name:'周报模板.md',description:'资料库文件'}
];
const INITIAL_AUTOMATIONS = [{id:'tech-news',title:'科技早报',message:AUTOMATION_TEMPLATES[0].message,enabled:false,schedule:{...Schedule.defaults(),...AUTOMATION_TEMPLATES[0].schedule},mentions:[AUTOMATION_REFERENCES[0]],attachments:[],device:'本机',runs:[]}];
function newAutomationDraft(template) {
  return {title:template?.title || '',message:template?.message || '',enabled:true,schedule:{...Schedule.defaults(),...template?.schedule},mentions:[{...AUTOMATION_REFERENCES[0]}],attachments:[],runs:[]};
}
function AutomationEditor({initial,onCancel,onSave}) {
  const [draft,setDraft] = React.useState(() => initial ? {...initial,schedule:{...initial.schedule},mentions:initial.mentions.map(item=>({...item})),attachments:initial.attachments.map(item=>({...item}))} : newAutomationDraft());
  const [error,setError] = React.useState('');
  const fileInput = React.useRef(null);
  const update = patch => {setDraft(d=>({...d,...patch}));setError('');};
  const updateSchedule = patch => {setDraft(d=>({...d,schedule:{...d.schedule,...patch}}));setError('');};
  const save = () => {
    const invalid = !draft.message.trim() ? '请填写任务内容' : Schedule.validate(draft.schedule);
    if (invalid) {setError(invalid);return;}
    onSave(Schedule.makeTask(draft, draft.id || `automation-${Date.now()}`));
  };
  return <Dialog title={draft.id ? '编辑自动化任务':'新建自动化任务'} width={640} cancelLabel="取消" confirmLabel={draft.id ? '保存':'创建'} onCancel={onCancel} onConfirm={save} initialFocus="first" showClose>
    <div className="cs-automation-form">
      <div className="cs-automation-content-field"><div className="cs-automation-field-label" id="automation-content-label">任务内容 <span>必填</span></div>
        <Composer placement="automation" value={draft.message} onChange={message=>update({message})} placeholder="输入 @ 选择智能体、技能、连接器或资料库文件" mentionItems={AUTOMATION_REFERENCES} selectedMentions={draft.mentions} onMentionsChange={mentions=>update({mentions})} onAttach={()=>fileInput.current?.click()} width="100%" />
        <input ref={fileInput} type="file" multiple hidden onChange={event=>{const selected=Array.from(event.target.files || []).map(file=>({name:file.name,size:file.size,type:file.type}));update({attachments:[...draft.attachments,...selected]});event.target.value='';}} />
        {draft.attachments.length>0 && <ul className="cs-automation-attachments">{draft.attachments.map((file,index)=><li key={`${file.name}-${index}`}><Icon name="file" size={14}/><span>{file.name}</span><Button size="sm" variant="ghost" aria-label={`移除附件 ${file.name}`} onClick={()=>update({attachments:draft.attachments.filter((_,i)=>i!==index)})}>移除</Button></li>)}</ul>}
      </div>
      <div className="cs-automation-schedule-row"><Field label="频率"><Select options={Object.values(Schedule.frequencies)} value={Schedule.frequencies[draft.schedule.type]} onChange={label=>updateSchedule({type:Object.keys(Schedule.frequencies).find(key=>Schedule.frequencies[key]===label)})}/></Field>
        {draft.schedule.type==='one_time' && <Field label="日期"><Input type="date" value={draft.schedule.date} onChange={event=>updateSchedule({date:event.target.value})}/></Field>}
        {draft.schedule.type==='weekly' && <Field label="星期"><Select options={Schedule.weekdays} value={Schedule.weekdays[draft.schedule.weekday]} onChange={label=>updateSchedule({weekday:Schedule.weekdays.indexOf(label)})}/></Field>}
        {draft.schedule.type==='monthly' && <Field label="每月日期"><Select options={[...Array.from({length:30},(_,i)=>`${i+1} 日`),'月底']} value={draft.schedule.day===31?'月底':`${draft.schedule.day} 日`} onChange={label=>updateSchedule({day:label==='月底'?31:parseInt(label,10)})}/></Field>}
        <div className="cs-automation-time"><Field label="小时"><Select options={Array.from({length:24},(_,i)=>String(i).padStart(2,'0'))} value={String(draft.schedule.hour).padStart(2,'0')} onChange={value=>updateSchedule({hour:Number(value)})}/></Field><span aria-hidden="true">:</span><Field label="分钟"><Select options={Array.from({length:60},(_,i)=>String(i).padStart(2,'0'))} value={String(draft.schedule.minute).padStart(2,'0')} onChange={value=>updateSchedule({minute:Number(value)})}/></Field></div>
      </div>
      <Field label="标题（可选）"><Input placeholder="留空则用任务内容首行" value={draft.title} onChange={event=>update({title:event.target.value})}/></Field>
      <Checkbox label="启用" checked={draft.enabled} onChange={enabled=>update({enabled})}/>
      {error && <p className="cs-automation-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
function AutomationScreen({collapsed,onExpand,onOpenTask,initialItems=INITIAL_AUTOMATIONS}) {
  const [items,setItems] = React.useState(initialItems), [editor,setEditor] = React.useState(null), [deleting,setDeleting] = React.useState(null), [expanded,setExpanded] = React.useState(new Set()), [notice,setNotice] = React.useState('');
  const toggleHistory = id => setExpanded(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next;});
  const toggleEnabled = task => {setItems(list=>list.map(item=>item.id===task.id?{...item,enabled:!item.enabled}:item));setNotice(`${task.title}已${task.enabled?'停用':'启用'}`);};
  const save = task => {setItems(list=>list.some(item=>item.id===task.id)?list.map(item=>item.id===task.id?task:item):[task,...list]);setEditor(null);setNotice(task.id===editor?.id?'自动化任务已保存':'自动化任务已创建');};
  return <PageFrame><PageHeader title="自动化" collapsed={collapsed} onExpand={onExpand} actions={<Button icon={<Icon name="plus"/>} onClick={()=>setEditor(newAutomationDraft())}>新建自动化任务</Button>}/><PageScroll className="cs-resource-page-scroll"><div className="cs-resource-page-content cs-automation-page">

    {notice && <p className="cs-resource-page-notice" role="status">{notice}</p>}
    <div className="cs-automation-list">{items.length ? items.map(task=><ResourceCard key={task.id} variant="automation" layout="row" icon="automation" title={task.message} description={task.title} status={<StatusDot tone={task.enabled?'success':'idle'} label={task.enabled?'已启用':'已停用'}/>} automation={{schedule:Schedule.format(task.schedule),lastRun:task.runs[0]?.time || '尚未运行',device:task.device,runCount:task.runs.length,expanded:expanded.has(task.id)}} onToggleRuns={()=>toggleHistory(task.id)} menu={{groups:[{items:[{label:task.enabled?'停用':'启用',onSelect:()=>toggleEnabled(task)},{label:'编辑',onSelect:()=>setEditor(task)}]},{danger:true,items:[{label:'删除',onSelect:()=>setDeleting(task)}]}]}}>
      {(task.mentions.length>0 || task.attachments.length>0) && <div className="cs-automation-row-references">{task.mentions.map(item=><span key={`${item.kind}-${item.id}`}>@{item.name}</span>)}{task.attachments.length>0 && <span>{task.attachments.length} 个附件</span>}</div>}
      {expanded.has(task.id) && <div className="cs-automation-history">{task.runs.length ? task.runs.map(run=><div className="cs-automation-run" key={run.id}><Button variant="ghost" onClick={()=>onOpenTask?.({title:run.title,taskId:run.id})}>{run.title}</Button><span>{run.time}</span></div>):<p>暂无任务</p>}</div>}
    </ResourceCard>):<EmptyState title="暂无自动化任务" reason="创建自动化任务，或从下方模板开始。" action="新建自动化任务" onAction={()=>setEditor(newAutomationDraft())}/>}</div>
    <section className="cs-resource-page-section"><GroupHeading label="从模板快速添加"/><CardGrid>{AUTOMATION_TEMPLATES.map(template=><ResourceCard key={template.id} variant="template" icon={template.icon} title={template.title} description={template.description} status={<span>{Schedule.format(template.schedule)}</span>} action="使用模板" onAction={()=>setEditor(newAutomationDraft(template))}/>)}<ResourceCard variant="template" icon="plus" title="从空白创建" description="自定义任务指令与执行计划。" action="创建任务" onAction={()=>setEditor(newAutomationDraft())}/></CardGrid></section>
  </div></PageScroll>{editor && <AutomationEditor initial={editor} onCancel={()=>setEditor(null)} onSave={save}/>}{deleting && <Dialog title="删除自动化任务" description="确认删除这条自动化任务？" confirmLabel="删除" danger onCancel={()=>setDeleting(null)} onConfirm={()=>{setItems(list=>list.filter(item=>item.id!==deleting.id));setExpanded(previous=>{const next=new Set(previous);next.delete(deleting.id);return next;});setNotice('自动化任务已删除');setDeleting(null);}}/>}</PageFrame>;
}
window.AutomationScreen = AutomationScreen;

// Read-only source reference: renderer/modules/agents.js detail, editing,
// inheritance and runtime gates. All records/mutations below are memory-only fixtures.
const {Button,Input,Textarea,Field,Select,SettingsSection,StatusDot,Icon,InlineConfirm,EmptyState} = window.CogSeedDesignSystem_f581b5;
const AGENT_PROFILES = {
  credit:{source:'custom',category:'业务',intro:'核对项目材料与报告口径，整理待补材料，输出可复核的项目分析意见。',capabilities:['核对数据报表与项目材料','识别口径差异并定位原始证据'],standards:['每条问题附材料位置和核验依据','区分已核实事实与待补充事项'],memory:['数值统一使用标准单位，保留原始口径'],workflow:'1. 核对材料范围\n确认统计期间与待核验项目，记录缺失材料。\n\n2. 交叉核验\n逐项比对指标与项目申请，记录口径差异。\n\n3. 输出分析意见\n整理问题、证据位置和待补材料清单。',inheritance:null},
  compliance:{source:'platform',category:'业务',version:'1.0.0',intro:'对照制度条款审阅业务材料，列出需复核的差异及其依据。',capabilities:['定位材料与制度条款的差异'],standards:['引用对应条款与材料位置'],memory:[],workflow:'1. 读取材料\n确认业务范围与适用制度。\n\n2. 核对条款\n逐项记录差异与依据。\n\n3. 提交复核\n输出待人工确认的事项。',inheritance:null},
  report:{source:'custom',category:'业务',intro:'汇总运营指标，核对变化原因并生成进展简报。',capabilities:[],standards:[],memory:[],workflow:'',inheritance:[]},
  codex:{source:'external',category:'通用',intro:'通过 P3394 协议接入本机 Codex，在项目目录中实现功能、修复问题与重构代码。',memory:[],capabilities:[],standards:[],workflow:'',directory:'默认工作空间',inheritance:null},
  commander:{source:'commander',category:'通用',intro:'理解目标、拆解工作，并选择智能体、技能、连接器与工具完成任务。',memory:[],capabilities:['将需求拆成目标、约束、输入与交付结果','选择合适的智能体、技能和工具'],standards:['交接时明确目标、输入和成功条件','最终结果明确来源、限制与下一步'],workflow:'1. 理解目标\n梳理背景、约束与交付形式。\n\n2. 选择能力\n匹配任务需要的智能体、技能与工具。\n\n3. 编排执行\n按任务依赖推进执行。\n\n4. 读取结果\n识别缺口、错误和冲突。\n\n5. 恢复与改派\n继续执行或说明阻塞原因。\n\n6. 综合交付\n整理可直接使用的结果。',inheritance:null}
};
function agentProfile(item){return {category:'通用',source:'custom',intro:'',capabilities:[],standards:[],memory:[],workflow:'',inheritance:null,provider:'跟随全局默认',model:'跟随全局默认',reasoning:'跟随全局默认',format:'自动选择',...AGENT_PROFILES[item.id],...item};}
function AgentListField({title,values,editable,onChange}) {
  return <SettingsSection title={title} actions={editable && <Button size="sm" onClick={()=>onChange([...values,''])}>添加</Button>}>
    {values.length ? <div className="cs-agent-list">{values.map((value,i)=><div className="cs-agent-list-row" key={i}>{editable ? <Input aria-label={`${title} ${i+1}`} value={value} onChange={e=>onChange(values.map((v,n)=>n===i?e.target.value:v))}/>:<span>{value}</span>}{editable && <Button variant="ghost" aria-label={`删除${title} ${i+1}`} onClick={()=>onChange(values.filter((_,n)=>n!==i))}>删除</Button>}</div>)}</div>:<p className="cs-agent-muted">尚未添加</p>}
  </SettingsSection>;
}
function AgentWorkbench({item,editing,onEdit,onPatch,onBack,onUse,onRemove}) {
  const agent=agentProfile(item), external=agent.source==='external', commander=agent.source==='commander', definition=agent.source==='custom'||external;
  const [notice,setNotice]=React.useState(''),[confirm,setConfirm]=React.useState(false),[request,setRequest]=React.useState(''),[messages,setMessages]=React.useState([]),[directoryOpen,setDirectoryOpen]=React.useState(false),[directory,setDirectory]=React.useState(agent.directory||'');
  const heading=React.useRef(null);
  React.useEffect(()=>{heading.current?.focus();},[editing,item.id]);
  const patch=value=>{onPatch('provider' in value?{...value,model:'跟随全局默认'}:value);setNotice('已保存');};
  const field=(label,key,options,disabled=false)=><Field label={label}><Select aria-label={label} options={options} value={agent[key]} disabled={disabled} onChange={value=>patch({[key]:value})}/></Field>;
  return <div className="cs-agent-workbench">
    <header className="cs-agent-header" ref={heading} tabIndex={-1} aria-label="智能体操作">
      <Button variant="ghost" onClick={onBack}><Icon name="chevronLeft" size={14}/>返回列表</Button>
      <Icon name={item.icon||'file'} size={24}/>
      {editing&&definition ? <Field error={!agent.name.trim()?'名称不能为空':undefined}><Input aria-label="智能体名称" value={agent.name} onChange={e=>onPatch({name:e.target.value})}/></Field>:<h1>{agent.name}</h1>}
      {definition?<Select aria-label="智能体分类" options={['通用','业务','产研']} value={agent.category} onChange={value=>patch({category:value})}/>:<span className="cs-agent-muted">{agent.version ? `v${agent.version} · `:''}{agent.category}</span>}
      <div className="cs-agent-header-actions">{editing?<Button variant="primary" disabled={!agent.name.trim()} onClick={()=>{onEdit(false);setNotice('已完成编辑');}}>完成编辑</Button>:<><Button variant="primary" disabled={!agent.enabled} onClick={()=>onUse({title:`使用${agent.name}开展工作`})}>使用智能体</Button><Button onClick={()=>onEdit(true)}>编辑</Button>{!commander&&<Button onClick={()=>patch({enabled:!agent.enabled})}>{agent.enabled?'停用':'启用'}</Button>}{definition&&<Button variant="ghost" onClick={()=>setConfirm(true)}>卸载</Button>}</>}</div>
    </header>
    {notice&&<p className="cs-resource-page-notice" role="status">{notice}</p>}
    {confirm&&<InlineConfirm title={`卸载「${agent.name}」？`} description="卸载后，此智能体将从列表移除。" confirmLabel="卸载智能体" onCancel={()=>setConfirm(false)} onConfirm={onRemove}/>}
    <div className={`cs-agent-columns${editing&&definition&&!external?' is-editing':''}`}>
      <article className="cs-agent-body" aria-label="智能体管理工作台">
        {agent.source==='custom'&&<SettingsSection title="默认执行配置"><div className="cs-agent-fields">{field('默认提供方','provider',['跟随全局默认','DeepSeek'],agent.source==='platform')}{field('默认模型','model',agent.provider==='DeepSeek'?['跟随全局默认','DeepSeek V4 Flash']:['跟随全局默认'],agent.provider==='跟随全局默认')}{field('默认推理强度','reasoning',['跟随全局默认','自动','低','中','高'],agent.source==='platform')}</div><p className="cs-agent-muted">用于此智能体的默认执行配置。会话内的临时调整不会修改这里的默认值。</p></SettingsSection>}
        {external&&<SettingsSection title="P3394 Gateway"><StatusDot tone={agent.enabled?'success':'idle'} label={agent.enabled?'已启用':'已停用'}/></SettingsSection>}
        {editing&&definition?<Field label="简介"><Textarea value={agent.intro} onChange={e=>patch({intro:e.target.value})}/></Field>:agent.intro&&<p className="cs-agent-intro">{agent.intro}</p>}
        {!external&&(editing||agent.memory.length>0)&&<AgentListField title="核心记忆" values={agent.memory} editable={editing} onChange={value=>patch({memory:value})}/>}
        {!external&&(agent.capabilities.length>0||(editing&&definition))&&<AgentListField title="擅长能力" values={agent.capabilities} editable={editing&&definition} onChange={value=>patch({capabilities:value})}/>}
        {!commander&&<SettingsSection title="出生时继承"><p className="cs-agent-muted">创建时带走的认知，版本冻结在创建时刻。</p>{agent.inheritance===null?<p>此智能体创建时尚未记录出生认知，无法查看当时的继承记录。</p>:agent.inheritance.length?<ul>{agent.inheritance.map((entry,i)=><li key={i}>{entry}</li>)}</ul>:<p>创建时没有可继承的认知。</p>}</SettingsSection>}
        {!external&&(agent.standards.length>0||(editing&&definition))&&<AgentListField title="交付标准" values={agent.standards} editable={editing&&definition} onChange={value=>patch({standards:value})}/>}
        {!external&&!commander&&<SettingsSection title="输入输出">{field('输出格式','format',['自动选择','普通回复','数据看板','交互应用'],!definition)}</SettingsSection>}
        {external&&<SettingsSection title="项目目录" actions={<Button onClick={()=>setDirectoryOpen(true)}>更换目录</Button>}><div className="cs-agent-list-row"><Icon name="space" size={18}/><span>{agent.directory}</span></div>{directoryOpen&&<form className="cs-agent-directory" onSubmit={e=>{e.preventDefault();if(directory.trim()){patch({directory:directory.trim()});setDirectoryOpen(false);}}}><Field label="项目目录"><Input value={directory} onChange={e=>setDirectory(e.target.value)}/></Field><Button type="submit" disabled={!directory.trim()}>保存目录</Button><Button onClick={()=>setDirectoryOpen(false)}>取消</Button></form>}</SettingsSection>}
        {!external&&<SettingsSection title="工作流程">{editing&&definition?<Textarea aria-label="工作流程" minHeight={280} value={agent.workflow} onChange={e=>patch({workflow:e.target.value})}/>:agent.workflow?<div className="cs-agent-workflow">{agent.workflow.split('\n\n').map((step,i)=><section key={i}>{step.split('\n').map((line,n)=>n===0?<h3 key={n}>{line}</h3>:<p key={n}>{line}</p>)}</section>)}</div>:<p className="cs-agent-muted">未填写</p>}</SettingsSection>}
      </article>
      {editing&&definition&&!external&&<aside className="cs-agent-assistant" aria-label="智能体编辑对话"><h2>调整智能体</h2><div className="cs-agent-messages" role="log">{messages.length?messages.map((message,i)=><p key={i}>{message}</p>):<EmptyState title="描述需要调整的内容"/>}</div><form onSubmit={e=>{e.preventDefault();if(request.trim()){setMessages(old=>[...old,request.trim()]);setRequest('');setNotice('调整内容已记录');}}}><Field label="调整内容"><Textarea value={request} onChange={e=>setRequest(e.target.value)} placeholder="描述需要调整的内容"/></Field><Button type="submit" variant="primary" disabled={!request.trim()}>发送</Button></form></aside>}
    </div>
  </div>;
}
window.AgentWorkbench=AgentWorkbench;
window.agentProfile=agentProfile;

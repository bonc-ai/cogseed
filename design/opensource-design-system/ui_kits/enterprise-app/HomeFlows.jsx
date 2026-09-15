const { Dialog, Checkbox, Input, Button } = window.CogSeedDesignSystem_f581b5;

// Bundled, non-private records. No discovery, import, model call or filesystem access.
const CONTINUE_SESSIONS = [
  {id:'carry-codex-1',source:'Codex',title:'工作空间导航调整',time:'今天 11:20',summary:'目标：整理工作空间导航。\n当前进展：已确认页面入口与任务分组。\n已确认约束：保留现有任务内容。\n下一步：核对空间设置与任务跳转。'},
  {id:'carry-codex-2',source:'Codex',title:'项目材料核对工具',time:'昨天 17:40',summary:'目标：核对项目材料。\n当前进展：已整理材料清单。\n已确认约束：只处理提供的材料。\n下一步：复核缺失项并整理说明。'},
  {id:'carry-claude-1',source:'Claude Code',title:'团队报表汇总',time:'今天 09:30',summary:'目标：汇总团队报表。\n当前进展：已确认统计口径。\n已确认约束：保留来源与计算依据。\n下一步：核对数据差异。'}
];
function ContinueWorkDialog({ onClose, onOpenTask }) {
  const [step,setStep]=React.useState(0), [sources,setSources]=React.useState(['Codex']), [selected,setSelected]=React.useState([]), [query,setQuery]=React.useState(''), [error,setError]=React.useState(''), [ready,setReady]=React.useState(false);
  const available=CONTINUE_SESSIONS.filter(s=>sources.includes(s.source));
  const visible=available.filter(s=>`${s.title} ${s.source}`.toLowerCase().includes(query.toLowerCase().trim()));
  const records=available.filter(s=>selected.includes(s.id));
  const changeSource=(source,checked)=>{setSources(list=>checked?[...list,source]:list.filter(s=>s!==source));setSelected([]);setError('');};
  function advance(){
    if(step===0&&!sources.length){setError('选择至少一个来源。');return;}
    if(step===1&&!records.length){setError('选择至少一个会话。');return;}
    setError('');if(step<2)setStep(step+1);else if(!ready)setReady(true);else onClose();
  }
  return <Dialog title="导入历史会话并接续" width={640} onCancel={onClose} cancelLabel="取消" confirmLabel={step<2?'下一步':ready?'完成':'开始准备'} onConfirm={advance} confirmDisabled={step===0?!sources.length:step===1?!records.length:false}
    extra={<div className="cs-continue-content">
      <ol className="cs-continue-steps" aria-label="接续步骤">{['选择来源','选择会话','准备接续'].map((label,i)=><li key={label} aria-current={i===step?'step':undefined}>{i+1} · {label}</li>)}</ol>
      {step===0?<><h3>从哪个 Agent 导入历史会话？</h3><div className="cs-continue-list">{['Codex','Claude Code'].map(source=><Checkbox key={source} label={source} help={`${CONTINUE_SESSIONS.filter(s=>s.source===source).length} 个可选会话`} checked={sources.includes(source)} onChange={checked=>changeSource(source,checked)}/>)}</div></>:null}
      {step===1?<><h3>选择要接续的会话</h3><Input aria-label="搜索标题、项目或 Agent" placeholder="搜索标题、项目或 Agent" value={query} onChange={e=>setQuery(e.target.value)}/><div className="cs-continue-selection"><span>已选 {records.length} / {available.length}</span><Button variant="ghost" size="sm" onClick={()=>setSelected(list=>Array.from(new Set([...list,...visible.map(s=>s.id)])))}>全选当前结果</Button><Button variant="ghost" size="sm" onClick={()=>setSelected([])}>取消全选</Button></div><div className="cs-continue-list">{visible.map(s=><Checkbox key={s.id} label={s.title} help={`${s.source} · ${s.time}`} checked={selected.includes(s.id)} onChange={checked=>{setSelected(list=>checked?[...list,s.id]:list.filter(id=>id!==s.id));setError('');}}/>)}{!visible.length?<p role="status">没有匹配的会话。</p>:null}</div></>:null}
      {step===2?<><h3>{ready?'接续任务已准备好':'准备接续'}</h3><p>已选 {records.length} 个会话</p><div className="cs-continue-list">{records.map(s=><section key={s.id}><h4>{s.title}</h4><p className="cs-continue-summary">{s.summary}</p>{ready?<Button onClick={()=>{onClose();onOpenTask({id:s.id,title:s.title,agentName:'cogseed',content:'empty',initialMessage:s.summary});}}>打开任务</Button>:null}</section>)}</div></>:null}
      {error?<p role="alert" className="cs-continue-error">{error}</p>:null}
      {step>0&&!ready?<Button variant="ghost" onClick={()=>{setStep(step-1);setError('');}}>上一步</Button>:null}
    </div>} />;
}
Object.assign(window,{ContinueWorkDialog});

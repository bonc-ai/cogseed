const { Button } = window.CogSeedDesignSystem_f581b5;
// Snapshots use only fields consumed by today's task-row implementation.
const EXAMPLE_TASKS = [
  {id:'credit',title:'项目里程碑与提醒',running:2,queued:1,plan:{done:4,total:7,active:1},time:'2分'},
  {id:'monthly',title:'项目月度进展简报 v3',auto:true,plan:{done:7,total:7},time:'3小时',pinned:true},
  {id:'reconcile',title:'核对 T+1 交易对账差异',plan:{done:2,total:5,failed:1},time:'昨天'},
  {id:'review',title:'资料来源与引用复核',plan:{done:1,total:4,blocked:1},time:'昨天'},
  {id:'queued',title:'季度项目台账汇总',queued:2,time:'2天'},
  {id:'untitled',title:'',time:'3天'},
  {id:'channel',title:'小组运营问题跟进',channel:'飞书',time:'1小时'},
  {id:'space-credit',title:'项目材料清单核验',spaceId:'产品研发',running:1,plan:{done:2,total:6,active:1},time:'5分'},
  {id:'space-risk',title:'跨项目依赖关系图谱',spaceId:'产品研发',time:'1天'},
  {id:'space-wealth',title:'产品说明书要点提取',spaceId:'内容创作',time:'2天'},
];
const variants = [['default','默认'],['task','任务选中'],['closed','空间收起'],['long','长列表与长名称'],['empty','空数据'],['collapsed','侧栏收起']];
function SidebarSpecimen({ variant }) {
  const [route,setRoute] = React.useState(variant === 'task' ? 'task' : 'home');
  const [selected,setSelected] = React.useState(variant === 'task' ? 'credit' : null);
  const [collapsed,setCollapsed] = React.useState(variant === 'collapsed');
  const [notice,setNotice] = React.useState('');
  const [liveTasks,setLiveTasks]=React.useState([]);
  const tasks = variant === 'empty' ? [] : variant === 'long' ? Array.from({length:24},(_,i) => ({id:`long-${i}`,title:`${i+1} · 华东团队项目客户项目额度与到期风险核验工作记录`,time:`${i+1}天`,...(i===0?{running:1,queued:3,plan:{done:3,total:8,active:1}}:{})})) : EXAMPLE_TASKS;
  return <>
    <div className={collapsed ? 'stage is-collapsed' : 'stage'}>
      {collapsed ? <div className="collapsed-controls"><window.CollapsedSidebarControls onExpand={() => setCollapsed(false)} /></div> :
        <window.Sidebar route={route} onRoute={(next,task) => {setRoute(next);setSelected(task?.id);setNotice(next==='task'?task.title||'新任务':next==='home'?'已打开新建任务':`已选择${({spaces:'工作空间',automation:'自动化',capabilities:'智能体 / 技能 / 连接',command:'搜索'})[next]||next}`);}}
          selectedTaskId={selected} initialFolded={variant==='closed'?Object.fromEntries(window.SPACES.map(s=>[s.id||s.name,true])):{}}
          onCollapse={() => setCollapsed(true)} taskItems={[...liveTasks,...tasks]}
          spaces={variant === 'empty' ? [] : window.SPACES}
          onSettings={() => setNotice('已选择设置')} onSignOut={() => setNotice('已选择退出登录')} />}
    </div>
    <div className="specimen-toolbar"><Button size="sm" onClick={()=>setLiveTasks(rows=>[{id:`live-${rows.length}`,title:'上游新增任务',time:'刚刚'},...rows])}>加入上游任务</Button><Button size="sm" onClick={()=>setLiveTasks([])}>移除上游任务</Button></div>
    {notice && <div className="notice" role="status">{notice}</div>}
  </>;
}
function readVariant() {
  const hash = window.location.hash.slice(1);
  return variants.some(([id]) => id === hash) ? hash : 'default';
}
function Demo() {
  const [variant,setVariant] = React.useState(readVariant);
  const [revision,setRevision] = React.useState(0);
  React.useEffect(() => {
    const change = () => setVariant(readVariant());
    window.addEventListener('hashchange',change);
    return () => window.removeEventListener('hashchange',change);
  },[]);
  return <main><h1>侧边栏导航</h1>
    <div className="specimen-toolbar">
      <label>状态 <select value={variant} onChange={e => {setVariant(e.target.value);window.location.hash=e.target.value;}}>
        {variants.map(([id,label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <Button size="sm" variant="ghost" onClick={() => setRevision(n=>n+1)}>重置</Button>
    </div>
    <SidebarSpecimen key={`${variant}-${revision}`} variant={variant}/>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

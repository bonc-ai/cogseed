const { Toast, CommandPalette } = window.CogSeedDesignSystem_f581b5;
const TASKS = window.SIDEBAR_RECENT;
const PREVIEW_ROUTES = ['login','home','spaces','space','space-task','cognition','automation','capabilities','task','settings'];
function readPreviewRoute() {
  const page = new URLSearchParams(location.search).get('page') || document.getElementById('root')?.dataset.previewPage;
  return PREVIEW_ROUTES.includes(page) ? page : 'login';
}
function readCapabilityTab() { return new URLSearchParams(location.search).get('tab') || 'agents'; }
function readTask() {
  const q=new URLSearchParams(location.search);
  return {...TASKS[0],title:q.get('task') || TASKS[0].title,spaceId:q.get('space') || undefined,
    content:q.get('content') || undefined,agentName:q.get('actor') || undefined,reference:q.get('reference') || undefined};
}
function App() {
  const previousWorkspace=React.useRef('home');
  const [route,setRoute]=React.useState(readPreviewRoute);
  const [spaces,setSpaces]=React.useState(()=>window.SPACE_CARDS.map((s,i)=>({...s,id:`space-${i}`,owned:i<2,archived:false})));
  const [spaceId,setSpaceId]=React.useState(()=>new URLSearchParams(location.search).get('space') || 'space-0');
  const [task,setTask]=React.useState(readTask);
  const [collapsed,setCollapsed]=React.useState(false),[openSpace,setOpenSpace]=React.useState('产品研发');
  const [toast,setToast]=React.useState(null),[cmd,setCmd]=React.useState(false),[searchHistory,setSearchHistory]=React.useState([]);
  const [capabilityFilter,setCapabilityFilter]=React.useState(readCapabilityTab);
  const [agentDialog,setAgentDialog]=React.useState(false);
  React.useEffect(()=>{
    const restore=()=>{setRoute(readPreviewRoute());setSpaceId(new URLSearchParams(location.search).get('space') || 'space-0');setTask(readTask());setCapabilityFilter(readCapabilityTab());setCmd(false);setToast(null);setAgentDialog(false);};
    addEventListener('popstate',restore);return()=>removeEventListener('popstate',restore);
  },[]);
  React.useEffect(()=>{
    const key=e=>{if(e.isComposing||e.keyCode===229)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setCmd(v=>!v);}};
    addEventListener('keydown',key);return()=>removeEventListener('keydown',key);
  },[]);
  const go=(next,payload)=>{
    if(next==='command'){setCmd(true);return;}
    if(!PREVIEW_ROUTES.includes(next))return;
    if(next==='settings'&&route!=='settings'&&route!=='login')previousWorkspace.current=route;
    const url=new URL(location.href);url.searchParams.set('page',next);
    ['section','detail','tab','agent','edit','view','scene','all','task','content','actor','reference','query','action','market','skill'].forEach(k=>url.searchParams.delete(k));
    if(next==='task'||next==='space-task'){
      const value={...payload};
      if(!value.title)value.title='新任务';
      if(value.spaceId){setSpaceId(value.spaceId);url.searchParams.set('space',value.spaceId);}else url.searchParams.delete('space');
      if(!value.content && (value.reference||value.title==='新任务'||value.title==='空间模式'))value.content='empty';
      setTask(value);url.searchParams.set('task',value.title);
      if(value.content)url.searchParams.set('content',value.content);
      if(value.agentName)url.searchParams.set('actor',value.agentName);
      if(value.reference)url.searchParams.set('reference',value.reference);
    }else if(next==='space'){
      const id=payload?.id || spaceId;setSpaceId(id);url.searchParams.set('space',id);
    }else url.searchParams.delete('space');
    history.pushState(null,'',url);setRoute(next);setCmd(false);setToast(null);
  };
  const openCapabilities=(tab,item)=>{
    go('capabilities');setCapabilityFilter(tab);
    const url=new URL(location.href);url.searchParams.set('tab',tab);
    if(item?.agentId)url.searchParams.set('agent',item.agentId);
    if(item?.title)url.searchParams.set('query',item.title);
    history.replaceState(null,'',url);
  };
  const chooseResult=(item,group)=>{
    setCmd(false);
    if(group.id==='chat')go(item.spaceId?'space-task':'task',item);
    else openCapabilities(({agent:'agents',skill:'skills',context:'library'})[group.id] || 'agents',item);
  };
  const searchGroups=(window.SEARCH_PREVIEW || []).map(g=>g.id==='chat'?{...g,items:[...g.items,...spaces.flatMap(s=>s.tasks.map((t,i)=>({id:s.id+'-'+i,title:t[1],spaceId:s.id,meta:s.name,snippet:'空间任务 · '+s.name,icon:'message'})))]}:g);
  const taskSpace=spaces.find(s=>s.id===task.spaceId);
  const gallery=route==='task'&&document.getElementById('root')?.dataset.previewPage==='task'&&!new URLSearchParams(location.search).has('task');
  const taskView=<TaskScreen key={[task.title,task.spaceId,task.reference].join(':')} title={task.title} content={task.content || 'analysis'} agentName={task.agentName || taskSpace?.agents?.[0] || (task.content==='empty'?'cogseed':'项目助理')}
    initialMessage={task.initialMessage} initialReference={task.reference} workspace={taskSpace || null} initialState={task.content==='empty'?'idle':'running'}
    onOpenSpace={()=>go('space',taskSpace)} onBack={()=>go(taskSpace?'space':'home',taskSpace)} collapsed={collapsed} onExpand={()=>setCollapsed(false)}/>;
  return <div className="cs-window" style={{position:'relative'}}>
    {route==='login'?<LoginScreen onLogin={()=>go('home')}/>:route==='settings'?<SettingsScreen onBack={()=>go(previousWorkspace.current)} onLibrary={()=>openCapabilities('library')}/>:gallery?<TaskStateSheet/>:<>
      {!collapsed&&<Sidebar spaces={spaces.filter(s=>!s.archived)} route={route} onRoute={go} recent={TASKS} selectedTaskId={task.id||task.title} openSpace={openSpace} onSettings={()=>go('settings')} onSignOut={()=>go('login')} onToggleSpace={setOpenSpace} onCollapse={()=>setCollapsed(true)}/>}
      {route==='home'&&<HomeScreen spaces={spaces} collapsed={collapsed} onExpand={()=>setCollapsed(false)} onConnectAgent={()=>setAgentDialog(true)} onOpenTask={t=>go(t.spaceId?'space-task':'task',t)} onSubmit={value=>{const t=typeof value==='string'?{title:value.trim(),initialMessage:value.trim(),content:'empty'}:value;if(t?.title?.trim())go(t.spaceId?'space-task':'task',t);}}/>}
      {route==='spaces'&&<SpaceHubScreen spaces={spaces} setSpaces={setSpaces} collapsed={collapsed} onExpand={()=>setCollapsed(false)} onOpenTask={t=>go('space-task',t)} onOpenSpace={s=>go('space',s)}/>}
      {route==='space'&&<SpaceDetailScreen key={spaceId} space={spaces.find(s=>s.id===spaceId)} setSpaces={setSpaces} collapsed={collapsed} onExpand={()=>setCollapsed(false)} onBack={()=>go('spaces')} onOpenTask={t=>go('space-task',t)}/>}
      {(route==='task'||route==='space-task')&&taskView}
      {route==='cognition'&&<CognitionScreen collapsed={collapsed} onExpand={()=>setCollapsed(false)} onHome={()=>go('home')}/>}
      {route==='automation'&&<AutomationScreen onOpenTask={t=>go('task',t)} collapsed={collapsed} onExpand={()=>setCollapsed(false)}/>}
      {route==='capabilities'&&<CapabilitiesScreen initialFilter={capabilityFilter} collapsed={collapsed} onExpand={()=>setCollapsed(false)} onUse={t=>go('task',t)} onSearch={()=>setCmd(true)}/>}
    </>}
    {cmd&&<CommandPalette modal groups={searchGroups} history={searchHistory} onHistoryChange={setSearchHistory} onSelect={chooseResult} onClose={()=>setCmd(false)}/>}
    {agentDialog&&window.AgentCreateDialog&&<window.AgentCreateDialog open initialMode="external" onClose={()=>setAgentDialog(false)} onCreated={agent=>{setAgentDialog(false);openCapabilities('agents');const url=new URL(location.href);url.searchParams.set('agent',agent.id);url.searchParams.set('edit','1');history.replaceState(null,'',url);}}/>}
    {toast&&<div style={{position:'absolute',right:24,bottom:24,zIndex:'var(--cs-layer-toast)'}}><Toast title={toast} onClose={()=>setToast(null)}/></div>}
  </div>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

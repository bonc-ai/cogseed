const { Icon, IconButton, NavItem, UserMenu, SidebarTasks } = window.CogSeedDesignSystem_f581b5;

function TrafficLights() {
  return (
    <>
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cs-window-close)' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cs-window-minimize)' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--cs-window-maximize)' }} />
    </>
  );
}

// Shared window controls keep collapsed page headers consistent.
function CollapsedSidebarControls({ onExpand }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", flex: 'none' }}>
      <TrafficLights />
      <span style={{ width: 8 }} />
      <IconButton variant="quiet" size="sm" title="展开侧边栏" aria-label="展开侧边栏" onClick={onExpand}>
        <Icon name="sidebar" />
      </IconButton>
    </div>
  );
}

function SectionLabel({ children, action }) {
  return (
    <div style={{ padding: "var(--cs-space-4) var(--cs-space-6) var(--cs-space-2)", display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)" }}>
      <span style={{ font: 'var(--cs-type-label)', letterSpacing: 'var(--cs-tracking-label)', textTransform: 'uppercase', color: 'var(--cs-text-placeholder)' }}>{children}</span>
      {action ? <><span style={{ flex: 1 }} /><span style={{ display: 'flex', color: 'var(--cs-text-placeholder)', cursor: 'pointer' }}>{action}</span></> : null}
    </div>
  );
}

const { SIDEBAR_RECENT, SIDEBAR_PINNED, SPACES } = window;
const sidebarTupleIds=new WeakMap();
let sidebarTaskSerial=0;
function sidebarSpaceTasks(spaces){return spaces.map(space=>({...space,tasks:(space.tasks||[]).map(task=>{
  if(!Array.isArray(task))return typeof task==='string'?{id:`${space.id||space.name}::${task}`,title:task}:task;
  if(!sidebarTupleIds.has(task))sidebarTupleIds.set(task,`space-task-${++sidebarTaskSerial}`);
  return {id:task.id||sidebarTupleIds.get(task),title:task[1],running:task[0]==='running'?1:0};
})}));}

function Sidebar({ spaces = SPACES, route, onRoute, onCollapse, recent = SIDEBAR_RECENT, pinned = SIDEBAR_PINNED, openSpace, onToggleSpace, onSettings, onSignOut, taskItems, initialFolded, selectedTaskId, initialMenuId }) {
  return (
    <aside className="cs-sidebar" style={{
      height: '100%', minHeight: 0, overflow: 'hidden', width: 'var(--cs-sidebar-width)', minWidth: 'var(--cs-sidebar-width)', flex: 'none', background: 'var(--cs-sidebar-top)',
      borderRight: '1px solid var(--cs-border-subtle)', display: 'flex', flexDirection: 'column'
    }}>
      <div style={{ height: 'var(--cs-titlebar-height)', display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", padding: "0 var(--cs-space-4)", flex: 'none' }}>
        <TrafficLights />
        <span style={{ flex: 1 }} />
        <IconButton variant="quiet" size="sm" title="搜索" onClick={() => onRoute('command')}><Icon name="search" /></IconButton>
        <IconButton variant="quiet" size="sm" title="收起侧边栏" onClick={onCollapse}><Icon name="sidebar" /></IconButton>
      </div>
      <div className="cs-brand" style={{padding:"var(--cs-space-1) var(--cs-space-4) var(--cs-space-4)",display:'flex',alignItems:'center',gap:"var(--cs-space-2)",flex:'none'}}>
        <img src="../../assets/brand/logo.png" width="26" height="26" alt="" draggable="false" />
        <span style={{fontSize:15,fontWeight:600,letterSpacing:'-.01em'}}>CogSeed</span>
      </div>
      <nav style={{ padding: "0 var(--cs-space-3)", display: 'flex', flexDirection: 'column', gap: "var(--cs-space-1)", flex: 'none' }}>
        <NavItem icon={<Icon name="plus" />} label="新建任务" selected={route === 'home'} onClick={() => onRoute('home')} />
        <NavItem icon={<Icon name="space" />} label="工作空间" selected={route === 'spaces'} onClick={() => onRoute('spaces')} />
        <NavItem icon={<Icon name="clock" />} label="认知资产" active={route === 'cognition'} onClick={() => onRoute('cognition')} />
        <NavItem icon={<Icon name="automation" />} label="自动化" selected={route === 'automation'} onClick={() => onRoute('automation')} />
        <NavItem icon={<Icon name="connector" />} label="智能体 / 技能 / 连接" selected={route === 'capabilities'} onClick={() => onRoute('capabilities')} />
      </nav>
      <SidebarTasks recent={recent} pinned={pinned} spaces={sidebarSpaceTasks(spaces)} items={taskItems}
        initialFolded={initialFolded} initialMenuId={initialMenuId} selectedId={route === 'task' ? selectedTaskId : null}
        onOpen={task => onRoute('task', task)} onDeleteActive={() => onRoute('home')} />
      <div style={{ flex: 'none', borderTop: '1px solid var(--cs-border-subtle)', padding: "var(--cs-space-1) var(--cs-space-3)", background: 'var(--cs-sidebar-bottom)' }}>
        <UserMenu name="陈昱" description="个人工作空间" onSettings={onSettings} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar, TrafficLights, CollapsedSidebarControls, SectionLabel, SPACES, SIDEBAR_RECENT, SIDEBAR_PINNED });

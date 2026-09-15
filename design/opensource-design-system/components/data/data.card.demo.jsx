const { Avatar, AvatarGroup, Tag, GroupHeading, DataTable, TaskListItem, ScrollArea, AspectRatio, ConnectorCard } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [conn,setConn]=React.useState(true), [sortKey,setSortKey]=React.useState('due'), [dir,setDir]=React.useState(1);
  const [selected,setSelected]=React.useState(-1),[task,setTask]=React.useState('');
  const rows = window.ROWS;
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:"var(--cs-space-4) var(--cs-space-6)"}}>
      <div className="cs-col">
        <div className="cs-row" style={{gap:"var(--cs-space-3)"}}>
          <Avatar name="陈昱" self /><Avatar name="吴" size={30} /><Avatar name="李" size={36} />
          <AvatarGroup members={['吴','李']} overflow={3} ring="var(--cs-canvas)" />
        </div>
        <div className="cs-row" style={{gap:"var(--cs-space-2)"}}>
          <Tag>项目</Tag><Tag>项目</Tag><Tag variant="outline">季度</Tag><Tag variant="accent">@ 客户经理</Tag><Tag variant="version">v3</Tag><Tag variant="mono">XLSX · 1.2MB</Tag><Tag variant="success">数据不出域</Tag>
        </div>
        <GroupHeading label="进行中" action="查看全部" />
        <div>
          <TaskListItem onClick={()=>setTask("attention")} selected={task==="attention"} status="attention" title="项目里程碑与提醒" meta="步骤 4/7" time="2 分钟前" />
          <TaskListItem onClick={()=>setTask("success")} selected={task==="success"} status="success" title="项目月度进展简报 v3" meta="产物待确认" time="今天 11:20" last />
        </div>
        <DataTable selectedIndex={selected} onSelect={setSelected} sortKey={sortKey} sortDir={dir} onSort={k=>{setDir(k===sortKey?-dir:1);setSortKey(k)}}
          columns={[{key:'name',label:'客户名称',width:'1.5fr',primary:true},{key:'branch',label:'项目组'},{key:'due',label:'到期日',width:'.9fr',mono:true,sortable:true},{key:'amt',label:'预算/万',width:'.8fr',mono:true,align:'right',sortable:true}]}
          rows={rows} />
      </div>
      <div className="cs-col">
        <ConnectorCard name="核心业务数仓" meta="只读 · 行内网" enabled={conn} onToggle={setConn}
          description="项目存贷、客户、账户主题域；查询经脱敏视图，不落盘。" />
        <ScrollArea header="运行留痕" height={150}>
          <div className="cs-col" style={{padding:"var(--cs-space-2) var(--cs-space-3)",gap:"var(--cs-space-2)"}}>
            {[['14:02','建立数仓连接'],['14:03','拉取台账 1,842 条'],['14:04','按到期日筛出 137 条'],['14:05','关联项目组归属'],['14:06','比对上期项目报告口径']].map(([t,x])=>
              <div key={t} className="cs-row" style={{gap:"var(--cs-space-2)",fontSize: 'var(--cs-size-ui-sm)',color:'var(--cs-ink-70)'}}><span style={{fontFamily:'var(--cs-font-sans)',color:'var(--cs-text-placeholder)'}}>{t}</span>{x}</div>)}
          </div>
        </ScrollArea>
        <div className="cs-row" style={{gap:"var(--cs-space-3)",alignItems:'stretch'}}>
          <AspectRatio ratio="16/9" style={{flex:1}} />
          <AspectRatio ratio="1/1" style={{width:74}} />
          <AspectRatio ratio="1/1.414" style={{width:56,background:'var(--cs-white)'}} />
        </div>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

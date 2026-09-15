const { NavItem, Tabs, SegmentedControl, DropdownMenu, Accordion, Breadcrumb, Pagination, Icon, IconButton } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [notice,setNotice]=React.useState('');
  const [route,setRoute]=React.useState('home'), [tab,setTab]=React.useState(0), [seg,setSeg]=React.useState(0), [page,setPage]=React.useState(1);
  return (
    <div style={{display:'grid',gridTemplateColumns:'var(--cs-sidebar-width) 1fr',gap:"var(--cs-space-6)"}}>
      <div className="cs-col">
        <NavItem icon={<Icon name="plus" />} label="新建任务" selected={route === 'home'} onClick={() => setRoute('home')} />
        <NavItem icon={<Icon name="space" />} label="工作空间" selected={route === 'spaces'} onClick={() => setRoute('spaces')} />
        <NavItem label="产品研发" count={6} expanded />
        <NavItem label="项目材料清单核验" indent size="sm" />
        <a href="sidebar.card.html">打开侧边栏导航</a>
      </div>
      <div className="cs-col" style={{gap:"var(--cs-space-4)"}}>
        <div role="status" style={{color:'var(--cs-text-muted)',fontSize:13}}>{notice}</div>
        <Tabs value={tab} onChange={setTab} items={['预览',{label:'变更',count:12},{label:'引用',count:6},{label:'审计（无权限）',disabled:true}]} />
        <div className="cs-row" style={{gap:"var(--cs-space-3)"}}>
          <SegmentedControl items={['全部','我负责','已归档']} value={seg} onChange={setSeg} />
          <DropdownMenu open width={200} trigger={<IconButton variant="quiet"><Icon name="dots" size={15} /></IconButton>} groups={[
            {items:[{label:'存入空间',icon:'file',shortcut:'⌘S'},{label:'导出 PDF',icon:'export',submenu:true},{label:'重新运行',icon:'clock'}]},
            {label:'危险操作',danger:true,items:[{label:'删除任务与产物',icon:'trash'}]}
          ]} />
        </div>
        <div style={{height:132}}></div>
        <Accordion items={[
          {title:'数据来源与口径',meta:'3 项',body:<>项目台账_2026Q3.xlsx · 只读<br/>核心业务数仓 · 项目存贷主题域（脱敏视图）</>},
          {title:'留痕与审计记录',meta:'14:04',body:'14:04 允许一次访问通讯录 · 陈昱'}
        ]} />
        <Breadcrumb items={['工作空间','华东团队空间','…','项目到期与提醒']} />
        <Pagination page={page} pageCount={9} total={1842} pageSize={200} onChange={setPage} />
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

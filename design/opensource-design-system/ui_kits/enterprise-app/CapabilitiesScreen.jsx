// Capability routes remain semantic when tabs are removed. Numeric links are legacy.
const {PageFrame,PageHeader,PageScroll,PageTabs,PreviewNameEditor}=window;
const {ResourceCard,CardGrid,StatusDot,EmptyState,SegmentedControl,Button,Input,Switch,Select,Icon,GroupHeading,Dialog}=window.CogSeedDesignSystem_f581b5;
const CAPABILITY_KEYS=['agents','tools','skills','library','im'];
const CAPABILITY_TABS=['智能体','MCP 与工具','技能','资料库',"IM"];
function resolveCapabilityTab(value){const raw=String(value??'agents');return CAPABILITY_KEYS.includes(raw)?raw:({'0':'agents','1':'tools','3':'skills','4':'library','5':'im'}[raw]||'agents');}
window.resolveCapabilityTab=resolveCapabilityTab;
const CAPABILITIES=[
 {id:'commander',kind:0,name:'cogseed',icon:'space',enabled:true},
 {id:'codex',kind:0,name:'Codex',icon:'fileText',enabled:true},
 {id:'credit',kind:0,name:'项目分析师',icon:'file',enabled:true},
 {id:'compliance',kind:0,name:'合规审阅员',icon:'shield',enabled:true},
 {id:'report',kind:0,name:'经营分析师',icon:'fileText',enabled:false},
 {id:'ledger',kind:1,name:'项目台账',icon:'database',enabled:true,connected:true},
 {id:'warehouse',kind:1,name:'经营数据仓库',icon:'database',enabled:true,connected:false},
 {id:'library',kind:1,name:'制度库',icon:'connector',enabled:true,connected:true,error:true}
];
function readAgentRoute(){const params=new URLSearchParams(location.search);return {id:params.get('agent'),editing:params.get('edit')==='1'};}
function CapabilitiesScreen({collapsed,onExpand,onUse,onSearch,initialFilter='agents'}){
 const [items,setItems]=React.useState(()=>{const store=window.CapabilityAgentStore;if(!store.initialized){store.items=[...CAPABILITIES,...(store.items||[])];store.initialized=true;}return store.items;}),[filter,setFilter]=React.useState(()=>resolveCapabilityTab(initialFilter)),[query,setQuery]=React.useState(()=>new URLSearchParams(location.search).get('query')||''),[category,setCategory]=React.useState(0),[notice,setNotice]=React.useState(''),[creating,setCreating]=React.useState(null),[remove,setRemove]=React.useState(null),[toolEditor,setToolEditor]=React.useState(false),[detail,setDetail]=React.useState(null),[market,setMarket]=React.useState(()=>new URLSearchParams(location.search).get('market')||''),[agentRoute,setAgentRoute]=React.useState(readAgentRoute);
 React.useEffect(()=>{window.CapabilityAgentStore.items=items;},[items]);
 const patch=(id,value)=>setItems(old=>old.map(item=>item.id===id?{...item,...value}:item));
 React.useEffect(()=>{setFilter(resolveCapabilityTab(initialFilter));if(['2','6'].includes(String(initialFilter)))setNotice('此入口已调整，请从当前能力列表选择。');},[initialFilter]);
 React.useEffect(()=>{const restore=()=>{setAgentRoute(readAgentRoute());setMarket(new URLSearchParams(location.search).get('market')||'');setQuery(new URLSearchParams(location.search).get('query')||'');setFilter(resolveCapabilityTab(new URLSearchParams(location.search).get('tab')));};window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
 const openAgent=(id,editing=false)=>{const url=new URL(location.href);url.searchParams.set('page','capabilities');['market','query','skill'].forEach(k=>url.searchParams.delete(k));setMarket('');url.searchParams.set('tab','agents');if(id)url.searchParams.set('agent',id);else url.searchParams.delete('agent');if(editing)url.searchParams.set('edit','1');else url.searchParams.delete('edit');history.pushState(null,'',url);setAgentRoute({id,editing});setFilter('agents');setNotice('');};
 const changeTab=index=>{const key=CAPABILITY_KEYS[index],url=new URL(location.href);url.searchParams.set('tab',key);['agent','edit','skill','query','market'].forEach(k=>url.searchParams.delete(k));history.pushState(null,'',url);setFilter(key);setAgentRoute({id:null,editing:false});setQuery('');setCategory(0);setNotice('');setDetail(null);setToolEditor(false);setMarket('');};
 const openMarket=kind=>{const url=new URL(location.href);if(kind)url.searchParams.set('market',kind);else url.searchParams.delete('market');history.pushState(null,'',url);setMarket(kind);};
 const agents=items.filter(t=>t.kind===0).map(window.agentProfile);
 const categories=['全部',...new Set(agents.map(a=>a.category))];
 const visible=agents.filter(a=>(!category||a.category===categories[category])&&`${a.name} ${a.intro}`.toLowerCase().includes(query.trim().toLowerCase()));
 const managed=agents.find(a=>a.id===agentRoute.id);
 const useAgent=a=>onUse?.({title:`使用${a.name}开展工作`,agentName:a.name,content:'empty',initialMessage:`@${a.name} `});
 const agentCard=a=><ResourceCard key={a.id} title={a.name} icon={a.icon} onOpen={()=>openAgent(a.id)} description={a.intro} status={<span>{a.category}{a.version?` · v${a.version}`:''} · {a.standards.length} 项交付标准 · {(a.skills||[]).length} 项技能{!a.enabled?' · 已停用':''}</span>} action="使用此智能体" disabled={!a.enabled} onAction={()=>useAgent(a)} menu={{groups:[{items:[{label:'管理工作台',onSelect:()=>openAgent(a.id)},...(a.source==='custom'||a.source==='external'?[{label:'编辑',onSelect:()=>openAgent(a.id,true)}]:[]),...(a.source!=='commander'?[{label:a.enabled?'停用':'启用',onSelect:()=>patch(a.id,{enabled:!a.enabled})}]:[])]},...(a.source!=='commander'?[{danger:true,items:[{label:'删除',onSelect:()=>setRemove(a)}]}]:[])]}}/>;
 return <PageFrame><PageHeader collapsed={collapsed} onExpand={onExpand} title="智能体 / 技能 / 连接"/><PageScroll className="cs-resource-page-scroll cs-page-tabs-layout"><div className="cs-resource-page-content cs-capabilities-content">
 <PageTabs ariaLabel="智能体 / 技能 / 连接" items={CAPABILITY_TABS} value={CAPABILITY_KEYS.indexOf(filter)} onChange={changeTab}/>
 {notice&&<p role="status" className="cs-resource-page-notice">{notice}</p>}
 {filter==='agents'&&(market?<CapabilityMarketplace kind={market} onKindChange={openMarket} onBack={()=>openMarket('')}/>:agentRoute.id?(managed?<AgentWorkbench key={managed.id} item={managed} editing={agentRoute.editing} onEdit={editing=>openAgent(managed.id,editing)} onPatch={value=>patch(managed.id,value)} onBack={()=>openAgent(null)} onUse={onUse} onRemove={()=>{setItems(old=>old.filter(t=>t.id!==managed.id));openAgent(null);}}/>:<EmptyState title="智能体不存在" action="返回列表" onAction={()=>openAgent(null)}/>):<section aria-label="AI 团队">
 <window.ResourceToolbar leading={<SegmentedControl ariaLabel="智能体分类" items={categories} value={category} onChange={setCategory}/>} search={<Input size="md" icon="search" aria-label="搜索智能体" placeholder="搜索智能体" value={query} onChange={e=>setQuery(e.target.value)}/>} actions={<><Button onClick={()=>setCreating('create')}>创建智能体</Button><Button onClick={()=>openMarket('agent')}>更多</Button></>}/>
 {visible.length?<div className="cs-capability-sections">{[['commander','主智能体'],['external','外接 Agent'],['custom','自定义'],['platform','平台']].map(([source,label])=>{const group=visible.filter(a=>a.source===source);return group.length?<section key={source}><GroupHeading label={`${label} · ${group.length}`}/><CardGrid>{group.map(agentCard)}</CardGrid></section>:null;})}</div>:<EmptyState title="没有匹配的智能体" action="清除筛选" onAction={()=>{setQuery('');setCategory(0);}}/>}
 </section>)}
 {filter==='tools'&&<section aria-label="MCP 与工具"><window.ResourceToolbar search={<Input size="md" icon="search" aria-label="搜索连接" placeholder="搜索连接" value={query} onChange={e=>setQuery(e.target.value)}/>} actions={<Button onClick={()=>setToolEditor(true)}>添加 MCP 服务器</Button>}/>{toolEditor&&<PreviewNameEditor title="MCP 服务器名称" onCancel={()=>setToolEditor(false)} onSave={name=>{setItems(old=>[...old,{id:`mcp-${Date.now()}`,kind:1,name,icon:'connector',enabled:true,connected:false}]);setToolEditor(false);}}/>}{detail&&<div className="cs-capability-detail"><h2>{detail.name}</h2><p>工具：查询记录、检索文档</p><Button onClick={()=>setDetail(null)}>返回列表</Button></div>}<div className="cs-capability-sections">{[true,false].map(connected=><section key={String(connected)}><GroupHeading label={connected?'已连接':'可用连接'}/><CardGrid>{items.filter(t=>t.kind===1&&!!t.connected===connected&&t.name.includes(query)).map(t=><ResourceCard key={t.id} title={t.name} icon={t.icon} onOpen={()=>setDetail(t)} status={<StatusDot tone={t.error?'attention':t.connected?'success':'idle'} label={t.error?'连接异常':t.connected?'已连接':'未连接'}/>} action={t.error?'重试连接':!t.connected?'连接账户':'使用连接'} onAction={()=>t.error||!t.connected?setNotice('设计预览未连接 MCP 服务，请在安装版完成连接。'):onUse?.({title:`使用${t.name}开展工作`})}/>)}</CardGrid></section>)}</div></section>}
 {filter==='skills'&&<CapabilitySkills onUse={onUse}/>}
 {filter==='library'&&<CapabilityLibrary onSearch={onSearch} onUse={value=>onUse?.({title:`请阅读${value.name}`,reference:value.reference,content:'empty',initialMessage:`请阅读 ${value.name}：\n${value.text}`})}/>}
 {filter==='im'&&<section aria-label="IM"><IMConnectionManager/></section>}
 </div></PageScroll><AgentCreateDialog open={!!creating} initialMode={creating||'create'} onClose={()=>setCreating(null)} onCreated={agent=>{setItems([...window.CapabilityAgentStore.items]);setQuery('');setCategory(0);openAgent(agent.id,true);}}/>
 {remove&&<Dialog title={`删除${remove.name}？`} description="将从当前设计预览列表移除此智能体。" danger confirmLabel="删除" onCancel={()=>setRemove(null)} onConfirm={()=>{setItems(old=>old.filter(a=>a.id!==remove.id));setRemove(null);}}/>}
 </PageFrame>;
}
window.CapabilitiesScreen=CapabilitiesScreen;

// Structure and channel availability follow renderer/modules/messaging-settings.js.
// All account, scan and configuration changes are local preview state only.
function IMConnectionManager() {
  const channels = ['飞书','Lark','企业微信','Telegram','个人微信'];
  const [channel,setChannel] = React.useState('飞书');
  const [accounts,setAccounts] = React.useState({});
  const [scanning,setScanning] = React.useState(false);
  const [notice,setNotice] = React.useState('');
  const account = {linked:false,enabled:false,owner:'',ownerId:'',draftId:'',draftName:'',reply:'富文本消息',scope:'所有工作空间',...accounts[channel]};
  const patch = change => setAccounts(old => ({...old,[channel]:{...account,...change}}));
  const selectChannel = name => {setChannel(name);setScanning(false);setNotice('');};
  const isFeishu = channel === '飞书' || channel === 'Lark';
  return <div className="cs-im-page">
    <h2>连接管理</h2>
    <div className="cs-im-layout">
      <aside className="cs-im-menu" aria-label="消息渠道">
        <div className="cs-im-menu-heading"><h3>消息渠道</h3></div>
        <div className="cs-im-channel-list"><GroupHeading label="已开放" />
          {channels.map(name => <Button key={name} variant={channel === name ? 'primary':'ghost'} onClick={() => selectChannel(name)}><Icon name="connector" size={16} /><span>{name}</span>{accounts[name]?.linked && <span className="cs-im-channel-status">已绑定</span>}</Button>)}
        </div>
        <div className="cs-im-channel-list"><GroupHeading label="即将支持" />{['QQ 机器人','钉钉','Discord'].map(name => <Button key={name} variant="ghost" disabled><Icon name="connector" size={16} />{name}</Button>)}</div>
      </aside>
      <article className="cs-im-content" aria-label={`${channel}连接管理`}>
        <header className="cs-im-channel-header">
          <div className="cs-im-channel-icon"><Icon name="connector" size={28} /></div>
          <div className="cs-im-channel-copy"><div className="cs-im-channel-name"><h3>{channel}</h3>{isFeishu && <span className="cs-im-region">{channel === '飞书' ? '中国':'全球'}</span>}</div><StatusDot tone={account.linked ? 'success':'idle'} label={account.linked ? '已关联':'未关联'} /></div>
          <div className="cs-im-receive"><span>接收消息</span><Switch aria-label="接收消息" checked={account.enabled} onChange={value => {if(!account.linked){setNotice('请先关联机器人');return;}patch({enabled:value});}} /></div>
        </header>
        {notice && <p className="cs-im-notice" role="status">{notice}</p>}
        <section className="cs-im-section"><h3>当前账号</h3>
          <div className="cs-im-account"><Icon name="connector" size={20} /><div><strong>{channel}机器人</strong><StatusDot tone={account.linked ? 'success':'idle'} label={account.linked ? '已关联':'未关联'} /></div>{account.linked && <Button variant="ghost" onClick={() => {patch({linked:false,enabled:false,owner:'',ownerId:''});setNotice('已解除连接');}}>解除关联</Button>}</div>
        </section>
        <section className="cs-im-section"><div className="cs-im-section-row"><h3>关联机器人</h3><Button disabled={account.linked} onClick={() => {setScanning(true);setNotice('');}}>{account.linked ? '已关联':channel === 'Telegram' ? '连接机器人':'扫码'}</Button></div>
          {scanning && <div className="cs-im-scan"><h3>{channel === 'Telegram' ? '连接机器人':'关联机器人'}</h3><div className="cs-im-actions"><Button variant="primary" onClick={() => {patch({linked:true,enabled:true});setScanning(false);setNotice('已完成关联');}}>完成关联</Button><Button onClick={() => setScanning(false)}>取消</Button></div></div>}
        </section>
        <section className="cs-im-section"><h3>身份与投递</h3>
          {account.ownerId ? <div className="cs-im-section-row"><StatusDot tone="success" label={account.owner || account.ownerId} /><Button onClick={() => patch({owner:'',ownerId:''})}>解除身份绑定</Button></div>:<form className="cs-im-owner-form" onSubmit={event => {event.preventDefault();if(!account.draftId.trim()){setNotice('请填写归属人 ID');return;}patch({ownerId:account.draftId.trim(),owner:account.draftName.trim()});setNotice('归属人已保存');}}>
            <Input aria-label="归属人 ID" placeholder={isFeishu ? 'ou_xxxxxxxxxxxxxxxx':'归属人 ID'} value={account.draftId} onChange={e => patch({draftId:e.target.value})} />
            <Input aria-label="归属人名称" placeholder="选填：归属人名称" value={account.draftName} onChange={e => patch({draftName:e.target.value})} />
            <Button type="submit" variant="primary">保存归属人</Button>
          </form>}
        </section>
        <section className="cs-im-section cs-im-behavior"><h3>消息行为</h3><div>
          <div className="cs-im-setting-row"><span>机器人回复颗粒度</span><Select options={isFeishu ? ['富文本消息','流式卡片']:['富文本消息']} value={account.reply} onChange={value => patch({reply:value})} /></div>
          <div className="cs-im-setting-row"><span>工作空间访问范围</span><Select options={['所有工作空间','仅当前工作空间']} value={account.scope} onChange={value => patch({scope:value})} /></div>
        </div></section>
      </article>
    </div>
  </div>;
}

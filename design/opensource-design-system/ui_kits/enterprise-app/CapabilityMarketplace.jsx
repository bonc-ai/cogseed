// Shared capability-domain marketplace, composed from the existing design primitives.
// Reference: renderer/modules/marketplace.js; agent and skill More enter the same
// marketplace with a different initial tab. Catalog and document text are fixtures.
// No network, real installation, package execution or external navigation occurs.
(function () {
  const {ResourceCard,CardGrid,Input,Select,Tabs,Button,StatusDot,EmptyState}=window.CogSeedDesignSystem_f581b5;
  const kinds=['agent','skill','open'];
  const labels={agent:'智能体',skill:'技能',open:'开源项目'};
  const entries=[
    {id:'market-credit-agent',kind:'agent',name:'项目材料审阅',category:'业务',description:'梳理项目材料、识别待补充事项并整理复核依据。',file:'AGENT.md',body:'# 项目材料审阅\n\n先确认材料范围，再核验一致性并输出待确认问题。\n\n交付：材料目录、异常清单、来源引用。\n技能：文档摘要、项目报告口径核验。'},
    {id:'market-report-agent',kind:'agent',name:'进展简报编写',category:'文档处理',description:'汇总经营数据与业务说明，形成有来源依据的简报。',file:'AGENT.md',body:'# 进展简报编写\n\n确认统计期间与口径，整理变化原因和待核验事项。'},
    {id:'meeting-notes',kind:'skill',name:'会议纪要',category:'文档处理',description:'将会议材料整理为议题、决定与行动清单。',file:'SKILL.md',body:'# 会议纪要\n\n逐项记录决定、责任人和截止时间，保留尚未确定的事项。'},
    {id:'data-validation',kind:'skill',name:'数据质量核验',category:'数据分析',description:'检查缺失值、重复记录和汇总口径。',file:'SKILL.md',body:'# 数据质量核验\n\n检查数据完整性与一致性，输出异常清单及来源。'},
    {id:'open-document-tools',kind:'open',name:'文档转换工具',category:'文档处理',description:'用于常见办公文档格式转换的开源工具集合。',file:'README.md',body:'# 文档转换工具\n\n安装前需确认运行环境、依赖与许可证。\n\n包含：文本提取、文档转换与表格整理。'},
    {id:'open-data-tools',kind:'open',name:'数据整理工具',category:'数据分析',description:'用于清洗表格、检查重复数据与生成统计摘要。',file:'README.md',body:'# 数据整理工具\n\n确认数据范围后执行清洗，保留原始文件和处理记录。'}
  ];
  /** kind sets entry tab. selectedId/onSelect optionally control detail routing. */
  function CapabilityMarketplace({kind='agent',selectedId,onSelect,onBack,onKindChange}) {
    const [active,setActive]=React.useState(kinds.includes(kind)?kind:'agent');
    const [localId,setLocalId]=React.useState(null),[query,setQuery]=React.useState(''),[category,setCategory]=React.useState('全部'),[notice,setNotice]=React.useState('');
    const id=selectedId===undefined?localId:selectedId;
    const current=entries.find(item=>item.id===id);
    React.useEffect(()=>{setActive(kinds.includes(kind)?kind:'agent');},[kind]);
    React.useEffect(()=>{if(current)setActive(current.kind);setNotice('');},[id]);
    const select=value=>{if(onSelect)onSelect(value);if(selectedId===undefined)setLocalId(value);setNotice('');};
    const changeKind=index=>{const next=kinds[index];select(null);setActive(next);setQuery('');setCategory('全部');onKindChange?.(next);};
    const visible=entries.filter(item=>item.kind===active&&(category==='全部'||item.category===category)&&`${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
    const categories=['全部',...new Set(entries.filter(item=>item.kind===active).map(item=>item.category))];
    return <section style={{display:'grid',gap:'var(--cs-space-4)'}} aria-label="能力市场">
      <div className="cs-resource-page-toolbar"><Button onClick={()=>id?select(null):onBack?.()}>{id?'返回市场':`返回${labels[kind]||'能力'}`}</Button><h2 style={{font:'var(--cs-type-title)',margin:0}}>{current?.name||'市场'}</h2></div>
      <Tabs ariaLabel="市场资源类型" items={kinds.map(value=>labels[value])} value={kinds.indexOf(active)} onChange={changeKind}/>
      {notice&&<p role="alert" className="cs-resource-page-notice">{notice}</p>}
      {id?current?<><p>{current.description}</p><StatusDot tone="idle" label={`${labels[current.kind]} · ${current.category}`}/><div><h3 style={{font:'var(--cs-type-title)'}}>{current.file}</h3><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'var(--cs-type-body)'}}>{current.body}</pre></div><div className="cs-resource-page-toolbar"><Button onClick={()=>setNotice('尚未连接市场安装服务，请稍后重试。')}>安装{labels[current.kind]}</Button></div></>:<EmptyState title="资源不存在" reason="该资源可能已下架，请返回市场重新选择。" action="返回市场" onAction={()=>select(null)}/>:<><div className="cs-resource-page-toolbar"><Input aria-label="搜索市场资源" icon="search" placeholder="搜索名称或简介" value={query} onChange={event=>setQuery(event.target.value)}/><Select aria-label="市场资源分类" options={categories} value={category} onChange={setCategory}/></div>{visible.length?<CardGrid>{visible.map(item=><ResourceCard key={item.id} variant="capability" title={item.name} icon="fileText" description={item.description} status={<StatusDot tone="idle" label={item.category}/>} action="查看详情" onAction={()=>select(item.id)}/>)}</CardGrid>:<EmptyState title="没有匹配的资源" action="清除筛选" onAction={()=>{setQuery('');setCategory('全部');}}/>}</>}
    </section>;
  }
  window.CapabilityMarketplace=CapabilityMarketplace;
})();

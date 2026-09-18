const { PageFrame, PageHeader, PageScroll, ContinueWorkDialog } = window;
const { Composer, Button } = window.CogSeedDesignSystem_f581b5;

// Exact installed-client scenario templates; recipients are preview selections only.
const HOME_SCENARIOS = [
  {label:'深度研究',agent:'DeepResearcher',template:'深度研究 [主题]：收集资料，按关键维度对比证据，标出来源链接，最后给结论和可执行建议'},
  {label:'UI 设计',agent:'UIDesigner',template:'帮我设计 [页面/产品/流程] 的 UI：先明确布局、视觉方向、组件状态和响应式方案，再给出默认 HTML 设计稿'},
  {label:'AI/搜索曝光',agent:'SeoGeoAgent',template:'帮我分析 [网站/页面 URL] 的 SEO 和 GEO：抓取页面，诊断技术、内容和结构化数据问题，找增长机会并输出行动计划'},
  {label:'整理文档',agent:'OfficeWriter',template:'帮我整理 [材料/文件]：提取重点、理清结构，整理成可交付的文档、表格、演示或 PDF 版本'},
  {label:'开发软件',agent:'ProductDeveloper',template:'帮我开发 [应用/功能]：先确认需求和边界，再设计方案、实现代码、跑测试，并告诉我怎么验收'}
];
const SUGGESTIONS=['空间模式','继续之前的工作',...HOME_SCENARIOS.map(s=>s.label)];
function HomeScreen({ collapsed, onExpand, onOpenTask, onSubmit, onConnectAgent, spaces = [] }) {
  const [txt,setTxt]=React.useState(''), [effort,setEffort]=React.useState('自动'), [recipient,setRecipient]=React.useState({id:'cogseed',name:'cogseed',kind:'agent'}), [spaceId,setSpaceId]=React.useState('');
  const [continueOpen,setContinueOpen]=React.useState(false), [selection,setSelection]=React.useState(null), [hour,setHour]=React.useState(()=>new Date().getHours());
  React.useEffect(()=>{const timer=setInterval(()=>setHour(new Date().getHours()),60000);return()=>clearInterval(timer);},[]);
  const greeting=hour<6?'起得真早':hour<12?'早上好':hour<18?'下午好':'晚上好';
  function choose(s){
    setTxt(s.template);setRecipient({id:s.agent,name:s.agent,kind:'agent'});
    const match=/\[[^\]]+\]/.exec(s.template);
    setSelection({start:match.index,end:match.index+match[0].length,revision:Date.now()});
  }
  function submit(){if(!txt.trim())return;onSubmit({title:txt.trim(),agentName:recipient?.name||'cogseed',content:'empty',initialMessage:txt.trim(),spaceId});setTxt('');}
  return <PageFrame className="cs-home" home>
    <PageHeader collapsed={collapsed} onExpand={onExpand} style={{borderBottom:0}}/>
    <PageScroll className="cs-home-scroll"><div className="cs-home-content">
      <h1 className="cs-home-greeting">{greeting}，朋友</h1>
      <div className="cs-brand-composer"><img className="cs-brand-mascot" src="../../assets/brand/cogseed-squirrel-perch.png" alt="" draggable="false"/><Composer placement="home" value={txt} onChange={setTxt} placeholder="输入 @ 选择智能体、技能" recipient={recipient} onRecipientChange={setRecipient} editorSelection={selection}
        reasoningEffort={effort} onReasoningEffortChange={setEffort} spaceOptions={spaces.map(s=>({id:s.id,name:s.name}))} spaceId={spaceId} onSpaceChange={setSpaceId} onSend={submit} contextTags={[{label:`@ ${recipient?.name||'cogseed'}`,selected:true}]} /></div>
      <div className="cs-home-suggestions"><Button variant="ghost" size="sm" onClick={()=>onOpenTask({title:'空间模式',agentName:'空间构建师',content:'empty'})}>空间模式</Button><Button variant="ghost" size="sm" onClick={()=>setContinueOpen(true)}>继续之前的工作</Button>{HOME_SCENARIOS.map(s=><Button key={s.label} variant="ghost" size="sm" onClick={()=>choose(s)}>{s.label}</Button>)}</div>
    </div></PageScroll>
    {continueOpen?<ContinueWorkDialog onClose={()=>setContinueOpen(false)} onOpenTask={onOpenTask}/>:null}
  </PageFrame>;
}
Object.assign(window,{HomeScreen,SUGGESTIONS,HOME_SCENARIOS});

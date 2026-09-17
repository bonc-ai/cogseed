const { Composer, Button } = window.CogSeedDesignSystem_f581b5;
const { ComposerStatesPreview } = window;
const SECTIONS = [['scenes','首页与对话'],['automation','自动化表单'],['base','基础入口与宽度'],['spaces','工作空间选择'],['sending','发送与排队'],['attachments','附件'],['voice','语音'],['editing','正文编辑'],['blocked','不可发送']];
function SceneExample({placement}) {
  const [value,setValue]=React.useState('');
  return <div className="cs-scene-example"><h3>{placement==='home'?'新建任务首页':'已有对话'}</h3>
    <p className="cs-state-rule">{placement==='home'?'正文默认最小 80px，最高 260px。':'正文默认最小 64px，最高 200px。'}底栏、附件和引用另计高度。{placement==='home'?'首页不显示访问权限入口。':'访问权限沿用当前会话设置。'}</p>
    <Composer placement={placement} value={value} onChange={setValue} onSend={()=>setValue('')} contextTags={[{label:'@ 项目助理'}]}/>
  </div>;
}
function Demo(){
  const [active,setActive]=React.useState('scenes');
  React.useEffect(()=>{
    let frame=0;
    const update=()=>{frame=0;let current=SECTIONS[0][0];for(const [id] of SECTIONS){if(document.getElementById(id)?.getBoundingClientRect().top<=120)current=id;}setActive(current);};
    const scroll=()=>{if(!frame)frame=requestAnimationFrame(update);};
    window.addEventListener('scroll',scroll,{passive:true});
    const initial=requestAnimationFrame(()=>{const id=location.hash.slice(1);if(SECTIONS.some(([key])=>key===id))document.getElementById(id)?.scrollIntoView();update();});
    return ()=>{window.removeEventListener('scroll',scroll);cancelAnimationFrame(frame);cancelAnimationFrame(initial);};
  },[]);
  const [autoText,setAutoText]=React.useState(''), [autoRefs,setAutoRefs]=React.useState([]);
  const [txt,setTxt]=React.useState('');
  const [effort,setEffort]=React.useState('自动');
  const [space,setSpace]=React.useState(true);
  const [empty,setEmpty]=React.useState(false);
  const [previewWidth,setPreviewWidth]=React.useState(900);
  const [revision,setRevision]=React.useState(0);
  const reset = () => { setTxt(''); setRevision(v=>v+1); };
  return <div className="cs-composer-review-layout">
    <aside className="cs-composer-review-nav"><div className="cs-review-nav-title">输入台 · 快速定位</div>
      <nav aria-label="输入台状态目录">{SECTIONS.map(([id,label])=><a key={id} href={'#'+id} aria-current={active===id?'location':undefined}>{label}</a>)}</nav>
    </aside>
    <main className="cs-state-gallery">
    <h1>输入台</h1>

    <section id="scenes"><h2 className="cs-state-group-title">首页与对话</h2>
      <SceneExample placement="home"/><SceneExample placement="conversation"/>
    </section>
    <section id="automation" className="cs-state-group"><h2 className="cs-state-group-title">自动化表单</h2>
      <p className="cs-state-rule">仅正文、附件与 @ 入口。Enter 换行，表单底部创建动作提交；引用由宿主保存并在编辑时恢复。</p>
      <Composer placement="automation" value={autoText} onChange={setAutoText} selectedMentions={autoRefs} onMentionsChange={setAutoRefs}
        placeholder="输入 @ 选择智能体、技能、连接器或资料库文件" mentionItems={[
          {id:'default',kind:'agent',name:'cogseed'}, {id:'summary',kind:'skill',name:'工作总结'},
          {id:'calendar',kind:'connector',name:'日历'}, {id:'guide',kind:'library',name:'工作流程.pdf'}]}/>
    </section>
    <section id="base" className="cs-state-group"><h2 className="cs-state-group-title">基础入口与宽度</h2>
    <div style={{display:'flex',alignItems:'center',gap:"var(--cs-space-2)",flexWrap:'wrap'}}>
      <Button size="sm" variant={!space?'primary':'secondary'} aria-pressed={!space} onClick={()=>{setSpace(false);reset();}}>普通任务</Button>
      <Button size="sm" variant={space?'primary':'secondary'} aria-pressed={space} onClick={()=>{setSpace(true);reset();}}>空间任务</Button>
      <Button size="sm" aria-pressed={empty} onClick={()=>{setEmpty(v=>!v);reset();}}>{empty?'恢复内容':'查看空列表'}</Button>
    </div>
    <div style={{display:'flex',gap:"var(--cs-space-2)",marginTop:"var(--cs-space-3)"}}>{[480,720,900].map(w=><Button key={w} size="sm" aria-pressed={previewWidth===w} variant={previewWidth===w?'primary':'secondary'} onClick={()=>setPreviewWidth(w)}>{w}px</Button>)}</div>

    <div style={{paddingTop:"var(--cs-space-3)"}}><Composer width={'min(' + previewWidth + 'px, 100%)'} key={revision} value={txt} onChange={setTxt}
      reasoningEffort={effort} onReasoningEffortChange={setEffort} spaceBound={space} onSpaceChange={id=>setSpace(Boolean(id))}
      mentionItems={empty?[]:undefined} onSend={()=>setTxt('')}
      contextTags={[{label:'@ 项目助理',selected:true}, ...(space?[{label:'华东团队空间'}]:[])]} /></div>

    </section>
    <section id="spaces" className="cs-state-group"><h2 className="cs-state-group-title">工作空间选择</h2>
      <p className="cs-state-rule">点击入口可搜索并切换工作空间；当前空间仅用对勾表示。默认工作区不绑定空间，@ 分类随之变化；切换不自动清空既有引用。</p>
      <div style={{paddingTop:"var(--cs-space-3)"}}><Composer spaceBound contextTags={[{label:'@ 项目助理'},{label:'华东团队空间'}]}/></div>
    </section>
    <section className="cs-state-group"><h2 className="cs-state-group-title">执行配置能力限制</h2>

      <Composer modelName="智能体当前模型" providerName="外接智能体" modelSupported={false} effortSupported={false}/>
    </section>
    <ComposerStatesPreview/>
  </main></div>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

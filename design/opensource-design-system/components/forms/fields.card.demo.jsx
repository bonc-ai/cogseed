const { Input, Field, Textarea, Select, SearchableSelect, Checkbox, Radio, RadioCard, Switch, Slider, Stepper, TagInput } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [sel,setSel]=React.useState('华东团队');
  const [branch,setBranch]=React.useState('静安小组');
  const [ck,setCk]=React.useState(true);
  const [rd,setRd]=React.useState(0);
  const [sw,setSw]=React.useState([true,true,false]);
  const [days,setDays]=React.useState(60);
  const [limit,setLimit]=React.useState(500);
  const [tags,setTags]=React.useState(['静安小组','虹口小组']);
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:"var(--cs-space-4) var(--cs-space-6)"}}>
      <div className="cs-col">
        <Input icon="search" placeholder="搜索任务、产物与空间" suffix="⌘K" />
        <Field label="日期" error="日期不存在，请按 YYYY-MM-DD 填写。"><Input mono defaultValue="2026-13-01" invalid /></Field>
        <Input prefix="https://" size="md" defaultValue="dw.internal.bank/api" />
        <Input disabled defaultValue="由管理员统一配置" />
      </div>
      <div className="cs-col">
        <Field label="提醒抄送范围" optional help="抄送对象仅收到汇总口径，不含客户明细。">
          <Input defaultValue="团队行长 · 风险条线负责人" />
        </Field>
        <Field label="提醒正文" count="48 / 300" help="支持 @ 引用客户字段">
          <Textarea defaultValue="您名下有 3 户项目将于 60 天内到期，请在 9 月 15 日前反馈续项目意向。" />
        </Field>
      </div>
      <div className="cs-col">
        <Select aria-label="分部" value={sel} onChange={setSel} groupLabel="按分部" options={['华东团队','华北团队','总行风险条线']} disabledOptions={['同业与外部协作（无权限）']} />
        <SearchableSelect aria-label="小组" value={branch} onChange={setBranch} recent={['虹口小组']} total={47} options={['静安小组','虹口小组','浦东小组','徐汇小组']} placeholder="小组" />
      </div>
      <div className="cs-col">
        <div className="cs-row" style={{gap:"var(--cs-space-4)"}}>
          <Checkbox checked label="已选" /><Checkbox indeterminate label="部分" /><Checkbox label="未选" /><Checkbox disabled label="禁用" />
        </div>
        <Checkbox checked={ck} onChange={setCk} label="导出前脱敏" help="客户名称保留，账号与联系方式以掩码导出。" />
        <div className="cs-row" style={{gap:"var(--cs-space-4)"}}>
          <Radio name="field-radio" value="task" checked={rd===0} label="仅本次任务" onChange={()=>setRd(0)} />
          <Radio name="field-radio" value="space" checked={rd===1} label="本空间 7 天内" onChange={()=>setRd(1)} />
          <Radio name="field-radio" value="long" disabled label="长期授权（需管理员）" />
        </div>
        <div className="cs-row" style={{gap:"var(--cs-space-3)"}}>
          {sw.map((v,i)=><Switch key={i} checked={v} onColor={i===1?'var(--cs-attention)':'var(--cs-ink)'} onChange={x=>setSw(s=>s.map((y,j)=>j===i?x:y))} />)}
          <span style={{fontSize: 'var(--cs-size-caption)',color:'var(--cs-ink-55)'}}>开 / 条件开 / 关</span>
        </div>
      </div>
      <div className="cs-col">
        <div className="cs-row"><span style={{fontSize: 'var(--cs-size-ui-sm)',fontWeight:500}}>到期提醒提前天数</span><span style={{flex:1}}></span><span style={{font:'500 var(--cs-size-ui) var(--cs-font-sans)'}}>{days} 天</span></div>
        <Slider value={days} min={15} max={120} ticks={[15,30,60,90,120]} onChange={setDays} />
        <Stepper value={limit} step={100} onChange={setLimit} />
      </div>
      <div className="cs-col">
        <Field label="收件项目组" help={'已选 ' + tags.length + ' / 9，回车添加、点击关闭图标移除。'}>
          <TagInput tags={tags} onChange={setTags} />
        </Field>
        <RadioCard name="field-radio-card" value="balanced" checked title="均衡" help="约 1 分钟，覆盖主要口径" />
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

const { CommandPalette, Button, DateRangePicker, Calendar, Dropzone, FileRow } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [range,setRange]=React.useState({start:'2026-09-01',end:'2026-09-15'});
  const [p,setP]=React.useState('');
  const [history,setHistory]=React.useState([]), [opened,setOpened]=React.useState(null), [modal,setModal]=React.useState(false);
  const groups=[
    {id:'chat',label:'任务',items:[{id:'task-1-message-1',title:'项目里程碑与提醒',meta:'你 · 今天 11:20',snippet:'核对本季度到期项目台账。'},{id:'task-1-message-2',title:'项目里程碑与提醒',meta:'AI · 今天 11:21',snippet:'已整理到期客户清单与提醒日期。'}]},
    {id:'agent',label:'智能体',items:[{id:'agent-credit',title:'项目分析',meta:'已安装',snippet:'核对客户资料与项目风险。'}]},
    {id:'skill',label:'技能',items:[{id:'skill-report',title:'整理文档',meta:'已安装',snippet:'整理项目材料和到期报告。'}]},
    {id:'context',label:'资料库',items:[{id:'context-1',title:'项目台账说明.md',meta:'资料库',snippet:'项目到期日期的核对口径。'}]}
  ];
  const select=(item,group)=>{setOpened({item,group});setModal(false);};
  return (
    <div className="cs-col" style={{gap:"var(--cs-space-4)"}}>
      <CommandPalette groups={groups} history={history} onHistoryChange={setHistory} onSelect={select} />
      <Button onClick={()=>setModal(true)}>打开全局搜索</Button>
      {modal && <CommandPalette modal groups={groups} history={history} onHistoryChange={setHistory} onSelect={select} onClose={()=>setModal(false)} />}
      {opened && <section aria-label="内容详情"><h2 style={{font:'var(--cs-type-title)'}}>{opened.item.title}</h2><p>{opened.group.label} · {opened.item.meta}</p><p>{opened.item.snippet}</p><Button variant="ghost" onClick={()=>setOpened(null)}>关闭详情</Button></section>}
      <div style={{display:'grid',gridTemplateColumns:'1fr 276px',gap:"var(--cs-space-6)",alignItems:'start'}}>
        <div className="cs-col" style={{gap:"var(--cs-space-3)"}}>
          <DateRangePicker value={range} onChange={r=>{setRange(r);setP('');}} presets={['本季度']} presetRanges={{'本季度':{start:'2026-07-01',end:'2026-09-30'}}} preset={p} onPreset={setP} />
          <Dropzone />
          <FileRow name="项目台账_2026Q3.xlsx" meta="1.2MB · 已就绪 · 只读" />
          <FileRow name="团队项目报告汇总.pdf" state="uploading" progress={62} />
          <FileRow name="客户联系表.csv" state="blocked" action="申请授权" meta="含个人联系信息，需在任务内单次授权后才能解析。" />
        </div>
        <Calendar month="2026 年 9 月" rangeStart={range.start<'2026-09-01'?1:range.start>'2026-09-30'?31:Number(range.start.slice(-2))} rangeEnd={range.end>'2026-09-30'?30:range.end<'2026-09-01'?0:Number(range.end.slice(-2))} onSelect={d=>{setRange({start:'2026-09-01',end:'2026-09-'+String(d).padStart(2,'0')});setP('');}} footer={range.start+' → '+range.end} />
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

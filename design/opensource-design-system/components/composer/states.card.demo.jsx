const { Composer, ComposerQueue, ComposerAttachments, ComposerVoice, ComposerNotice, ComposerRichDraft } = window.CogSeedDesignSystem_f581b5;
const TAGS = [{label:'@ 项目助理',selected:true},{label:'华东团队空间'}];
const SAMPLE_FILES = [
  {id:'a',name:'项目台账_2026Q3.xlsx',size:'1.2 MB',status:'ready'},
  {id:'b',name:'访谈记录.docx',size:'680 KB',status:'uploading'},
  {id:'c',name:'财务报表.pdf',size:'3.4 MB',status:'ready'},
  {id:'d',name:'交付后监测补充资料_华东团队_2026年第三季度.docx',size:'820 KB',status:'ready'},
  {id:'e',name:'客户现场记录.mp4',size:'8.1 MB',status:'ready',video:true}
];
function Example({title, rule, children}) {
  return <section className="cs-state-example"><h2>{title}</h2><div className="cs-state-stage">{children}</div></section>;
}
function Draft({initial='',phase='idle',notice,sendAllowed,inputDisabled,...rest}) {
  const [value,setValue]=React.useState(initial),[feedback,setFeedback]=React.useState(''),[effort,setEffort]=React.useState('自动');
  return <><Composer value={value} onChange={setValue} phase={phase} sendAllowed={sendAllowed} inputDisabled={inputDisabled}
    contextTags={TAGS} spaceBound reasoningEffort={effort} onReasoningEffortChange={setEffort}
    onSend={()=>{setValue('');setFeedback('消息已发送');}} onStop={()=>setFeedback('已发出停止请求')}
    onQueue={()=>{setValue('');setFeedback('消息已加入队列');}}
    afterInput={notice && <ComposerNotice message={notice}/>} {...rest}/>
    {feedback && <p className="cs-state-feedback" role="status">{feedback}</p>}</>;
}
function QueueExample({editing=false}) {
  const [items,setItems]=React.useState([{id:'q1',text:'请按团队汇总到期客户。'},{id:'q2',text:'再补充未来 30 天的提醒清单。'}]);
  const [text,setText]=React.useState('请同时标注缺失材料。');
  const [running,setRunning]=React.useState(true),[status,setStatus]=React.useState('正在执行 · 点击停止回复，Enter 将文字加入队列');
  const stop = () => {
    const next = items[0];
    if (next) { setItems(items.slice(1)); setStatus('当前回复已停止，正在处理：' + next.text + ''); }
    else { setRunning(false); setStatus('当前回复已停止。'); }
  };
  return <div className="cs-queue-composition"><ComposerQueue items={items} onChange={setItems} initialEditingId={editing?'q1':null}/>
    <Composer value={text} onChange={setText} contextTags={TAGS} phase={running?'running':'idle'}
      onStop={stop} onSend={()=>setText('')}
      onQueue={()=>{setItems(v=>[...v,{id:'q-'+Date.now(),text}]);setText('');}}
      afterInput={<ComposerNotice message={status}/>}/></div>;
}
function Sending(){return <>
  <Example title="01 空白／可发送"><Draft/><div className="cs-state-gap"/><Draft initial="请核对这份项目材料。"/></Example>
  <Example title="02 首页提交中"><Draft placement="home" initial="请核对这份项目材料。" phase="submitting" notice="正在提交消息…"/></Example>
  <Example title="03 执行中"><QueueExample/></Example>
  <Example title="04 停止中"><Draft phase="stopping" notice="正在停止回复…"/></Example>
  <Example title="05 队列编辑"><QueueExample editing/></Example>
</>;}
function FilesExample({initial,dragging=false}) {
  const [items,setItems]=React.useState(initial),[drag,setDrag]=React.useState(dragging);
  const add = names => setItems(v=>[...v,...names.map((name,i)=>({id:Date.now()+'-'+i,name,size:'已就绪',status:'ready'}))]);
  const notice=items.some(i=>i.status==='uploading')?'附件仍在上传，完成后可发送。':undefined;
  return <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDrag(false);}}
    onDrop={e=>{e.preventDefault();setDrag(false);add(Array.from(e.dataTransfer.files).map(f=>f.name));}}
    onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();add(Array.from(e.clipboardData.files).map(f=>f.name));}}}>
    <Draft initial="请核对附件内容。" sendAllowed={notice?false:undefined} notice={notice}
      onAttach={()=>add(['补充材料.pdf'])}
      beforeInput={<ComposerAttachments items={items} dragging={drag} onRemove={id=>setItems(v=>v.filter(i=>i.id!==id))}/>}/>
  </div>;
}
function Attachments(){return <>
  <Example title="01 添加／拖入／粘贴"><FilesExample initial={[]} dragging/></Example>
  <Example title="02 上传中／就绪"><FilesExample initial={SAMPLE_FILES.slice(0,2)}/></Example>
  <Example title="上传失败提示"><Draft initial="请核对附件内容。" beforeInput={<ComposerAttachments items={[SAMPLE_FILES[0]]}/>} afterInput={<ComposerNotice tone="error" message="财务报表.pdf 上传失败，请重新添加。"/>}/></Example>
  <Example title="03 多附件与长名称"><FilesExample initial={SAMPLE_FILES.map(i=>({...i,status:'ready'}))}/></Example>
  <Example title="04 图片附件"><FilesExample initial={[{id:'scan',name:'材料扫描页.png',size:'240 KB',status:'ready',thumbnail:'attachment-preview.svg'}]}/></Example>
</>;}
function Recording({state='idle'}) {
  const [recording,setRecording]=React.useState(state==='recording');
  const [text,setText]=React.useState(state==='recording'?'请整理今天的客户走访记录':'');
  return <Composer value={text} onChange={setText} contextTags={TAGS}
    onSend={()=>setText('')} voiceActive={recording}
    onVoice={()=>{if(recording)setRecording(false);else{setRecording(true);setText('请整理今天的客户走访记录');}}}
    voicePanel={recording ? <ComposerVoice onCancel={()=>{setText('');setRecording(false);}}/> : null}/>
}
function Voice(){return <>
  <Example title="点击麦克风开始"><Recording/></Example>
  <Example title="01 录音与实时转写"><Recording state="recording"/></Example>
  <Example title="02 结束录音"><Recording state="recording"/></Example>
  <Example title="03 转写完成"><Draft initial="请整理今天的客户走访记录，并列出后续待办。"/></Example>
  <Example title="04 麦克风权限不足"><ComposerNotice tone="error" message="无法访问麦克风。请在系统设置中允许访问后，再点击麦克风。"/></Example>
  <Example title="05 未检测到设备"><ComposerNotice tone="error" message="未检测到麦克风设备，请检查麦克风是否连接。"/></Example>
  <Example title="06 取消后的结果"><Draft/></Example>
</>;}
function RichExample(){return <Draft sendAllowed={false} editor={<ComposerRichDraft/>}/>;}
function Editing(){return <>
  <Example title="01 多行输入"><Draft initial={'请核对这份项目清单。\n按客户列出缺失材料。\n最后给出补充建议。'}/></Example>
  <Example title="02 达到最大高度"><Draft initial={Array.from({length:16},(_,i)=>(i+1)+'. 核对客户材料与项目审查口径，列出需要补充的信息。').join('\n')}/></Example>
  <Example title="03 正文内技能标签"><RichExample/></Example>
  <Example title="04 最小宽度"><Draft width={480} initial={'请按团队整理客户信息。\n保留风险事项和后续跟进人。'}/></Example>
</>;}
function Blocked(){return <>
  <Example title="01 附件上传中"><Draft initial="请分析这份材料。" sendAllowed={false} beforeInput={<ComposerAttachments items={[SAMPLE_FILES[1]]}/>}
    afterInput={<ComposerNotice message="附件仍在上传，完成后再发送。"/>}/></Example>
  <Example title="02 智能体不可用"><Draft initial="请继续核对材料。" inputDisabled
    afterInput={<ComposerNotice tone="error" message="当前会话绑定的智能体已停用，请在智能体管理中重新启用，或另建任务。"/>}/></Example>
  <Example title="03 带附件不能排队"><Draft initial="请同时查看补充材料。" phase="running" sendAllowed={false}
    beforeInput={<ComposerAttachments items={[SAMPLE_FILES[0]]}/>}
    afterInput={<ComposerNotice message="带附件的消息暂不支持排队，请等待当前回复结束后发送。"/>}/></Example>
  <Example title="04 仅有附件"><Draft sendAllowed={false} beforeInput={<ComposerAttachments items={[SAMPLE_FILES[0]]}/>}
    afterInput={<ComposerNotice message="添加任务说明后再发送。"/>}/></Example>
  <Example title="05 仅有消息引用"><Draft sendAllowed
    beforeInput={<div className="cs-quote-sample">引用消息 · 请重点核对未来 30 天内到期的项目。</div>}/></Example>
</>;}
function ComposerStatesPreview(){
  return <div className="cs-state-sections">{[[Sending,'sending','01 发送与排队'],[Attachments,'attachments','02 附件'],[Voice,'voice','03 语音'],[Editing,'editing','04 正文编辑'],[Blocked,'blocked','05 不可发送']].map(([View,id,title])=>
    <section className="cs-state-group" id={id} key={id}><h2 className="cs-state-group-title">{title}</h2><View/></section>
  )}</div>;
}
window.ComposerStatesPreview = ComposerStatesPreview;

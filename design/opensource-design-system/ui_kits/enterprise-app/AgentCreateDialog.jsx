// Shared business composition for home and the agent list. No runtime registration.
window.CapabilityAgentStore=window.CapabilityAgentStore||{items:null,initialized:false,add(agent){if(!this.items)this.items=[];this.items.push(agent);}};
function AgentCreateDialog({open,onClose,onCreated,initialMode='create'}) {
  const {Dialog,Tabs,Field,Input,Select,Textarea}=window.CogSeedDesignSystem_f581b5;
  const [mode,setMode]=React.useState(initialMode==='external'?1:0),[name,setName]=React.useState(''),[intro,setIntro]=React.useState(''),[format,setFormat]=React.useState('自动选择'),[cli,setCli]=React.useState('Codex'),[error,setError]=React.useState('');
  React.useEffect(()=>{if(open){setMode(initialMode==='external'?1:0);setName('');setIntro('');setError('');}},[open,initialMode]);
  if(!open)return null;
  const save=()=>{if(!name.trim()||!intro.trim()){setError('请填写名称和简介');return;}if(!/^[A-Za-z0-9_一-鿿-]+$/.test(name)){setError('名称仅支持中文、字母、数字、下划线和短横线');return;}if(['cogseed','commander'].includes(name.toLowerCase())){setError('此名称已保留，请换一个名称');return;}const agent={id:`custom-${Date.now()}`,kind:0,name,intro: intro.trim(),format,source:mode?'external':'custom',category:'通用',enabled:!mode,icon:mode?'fileText':'file',directory:'默认工作空间',runtime:mode?cli:undefined};window.CapabilityAgentStore.add(agent);onCreated?.(agent);onClose?.();};
  return <Dialog title="新建智能体" showClose width={520} onCancel={onClose} onConfirm={save} confirmLabel="确认" initialFocus="first">
    <div style={{display:'grid',gap:'var(--cs-space-4)'}}>
      <Tabs items={['创建','外接']} value={mode} onChange={value=>{setMode(value);setError('');}}/>
      {mode===1&&<Field label="智能体" help="通过 P3394 协议接入，注册为协作节点。"><Select options={['Codex','Claude Code','Hermes','OpenClaw','WorkBuddy']} value={cli} onChange={value=>{setCli(value);setName(value.replaceAll(' ',''));setIntro(`通过 ${value} 处理项目中的开发任务。`);}}/></Field>}
      <Field label="名称" error={error||undefined}><Input value={name} onChange={e=>{setName(e.target.value);setError('');}} placeholder="例如：项目分析师"/></Field>
      {mode===0&&<Field label="输出格式"><Select options={['自动选择','普通回复','数据看板','交互应用']} value={format} onChange={setFormat}/></Field>}
      <Field label="简介" help={mode===0?'一句话说明它做什么，作为工作流程的生成依据。':undefined}><Textarea value={intro} onChange={e=>setIntro(e.target.value)} placeholder="描述智能体负责的工作"/></Field>
      {mode===1&&<div><h3 style={{font:'var(--cs-type-ui)'}}>已接入的 P3394 节点</h3><p style={{font:'var(--cs-type-caption)',color:'var(--cs-text-secondary)'}}>已接入节点的启停与移除在智能体总览中管理。</p></div>}
      {mode===0&&<p style={{font:'var(--cs-type-caption)',color:'var(--cs-text-secondary)',margin:0}}>确认后可在管理工作台继续编辑。</p>}
    </div>
  </Dialog>;
}
window.AgentCreateDialog=AgentCreateDialog;

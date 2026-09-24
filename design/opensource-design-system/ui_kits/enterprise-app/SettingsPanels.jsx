const { InlineConfirm, SettingsSection, Button, Input, Select, Switch, RadioCard, Checkbox, DataTable } = window.CogSeedDesignSystem_f581b5;

// Preview-only settings workflows. State stays in React; no IPC, storage or network.
function SettingsChoice({label, options, value, onChange}) {
  return <div className="cs-settings-choice" role="group" aria-label={label}><Select size="md" aria-label={label} options={options} value={value} onChange={onChange} /></div>;
}
function SettingsActions({children}) { return <div className="cs-settings-actions">{children}</div>; }
function SettingsFeedback({children}) { return <div className="cs-settings-notice" role="status" aria-live="polite">{children}</div>; }
function SettingsConfirm({title, confirmLabel = '删除配置', onCancel, onConfirm}) {
  return <InlineConfirm title={title} confirmLabel={confirmLabel} onCancel={onCancel} onConfirm={onConfirm} />;
}
function SettingsGeneral() {
  const [prefs, setPrefs] = React.useState({language:'简体中文',thinking:'自动',notifications:true,access:'常规',evolution:false});
  const [notice,setNotice] = React.useState('');
  const update = (key,value) => {setPrefs(p => ({...p,[key]:value}));setNotice('设置已保存。');};
  return <>
    <SettingsSection title="语言与推理">
      <SettingsRow title="语言 / Language"><SettingsChoice label="语言" value={prefs.language} options={['简体中文','English','日本語','Português']} onChange={v => {update('language',v);setNotice('语言偏好已保存。');}} /></SettingsRow>
      <SettingsRow title="默认推理强度" help="任务内可临时调整，仅影响当前任务。"><SettingsChoice label="默认推理强度" value={prefs.thinking} options={['自动','关闭','低','高']} onChange={v => update('thinking',v)} /></SettingsRow>
    </SettingsSection>
    <SettingsSection title="任务通知"><SettingsRow title="启用任务通知" help="应用不在前台时，通知任务完成、失败或需要输入。"><Switch aria-label="启用任务通知" checked={prefs.notifications} onChange={v => update('notifications',v)} /></SettingsRow><SettingsRow title="系统通知权限"><Button onClick={() => setNotice('请在系统设置中管理通知权限。')}>打开系统设置</Button></SettingsRow></SettingsSection>
    <SettingsSection title="工具执行权限"><div className="cs-settings-options">{[['谨慎','仅访问工作区文件，敏感操作需确认'],['常规','可访问工作区外文件，敏感操作需确认'],['信任','可访问工作区外文件，敏感操作无需确认']].map(([title,help]) => <RadioCard name="tool-access" value={title} key={title} title={title} help={help} checked={prefs.access === title} onChange={() => update('access',title)} />)}</div></SettingsSection>
    <SettingsSection title="元认知级智能体自进化"><SettingsRow title="启用自进化" help="智能体定期回顾近期表现，提炼经验并调整工作方式。"><Switch aria-label="启用自进化" checked={prefs.evolution} onChange={v => update('evolution',v)} /></SettingsRow></SettingsSection>
    <SettingsFeedback>{notice}</SettingsFeedback>
  </>;
}
function SettingsUsage() {
  return <><SettingsSection title="体验额度 / 运行额度"><SettingsRow title="暂无额度数据"><span className="cs-settings-muted">暂无数据</span></SettingsRow></SettingsSection></>;
}
function SettingsAccount() {
  const [signed,setSigned] = React.useState(true), [devices,setDevices] = React.useState(['当前 Mac','Windows 设备']);
  const [confirm,setConfirm] = React.useState(null), [step,setStep] = React.useState(0), [code,setCode] = React.useState(''), [sent,setSent] = React.useState(false), [phrase,setPhrase] = React.useState(''), [checks,setChecks] = React.useState([false,false,false]), [notice,setNotice] = React.useState('');
  if (step) return <div className="cs-settings-editor"><h2>注销账号 · {step} / 3</h2>
    {step === 1 ? <><p>账号会话、设备访问和联网权益将停止，本机数据保留。</p></> : null}
    {step === 2 ? <><p>验证账号身份</p><SettingsActions><Input aria-label="验证码" placeholder="填写 6 位验证码" value={code} onChange={e => setCode(e.target.value)} /><Button onClick={() => {setSent(true);setNotice('验证码已发送。');}}>{sent ? '重新获取验证码':'获取验证码'}</Button></SettingsActions></> : null}
    {step === 3 ? <><div className="cs-settings-options">{['我知道账号会话、设备访问和联网权益会停止。','我知道反悔期内重新登录需先选择恢复账号或放弃登录。','我知道本机数据不会随云端账号注销而删除。'].map((label,i) => <Checkbox key={label} label={label} checked={checks[i]} onChange={v => setChecks(old => old.map((x,j) => i === j ? v:x))} />)}</div><Input aria-label="注销确认短语" placeholder="输入 DELETE_MY_ACCOUNT 确认" value={phrase} onChange={e => setPhrase(e.target.value)} /></> : null}
    <SettingsActions><Button onClick={() => {setStep(0);setNotice('');}}>取消注销</Button>{step > 1 ? <Button onClick={() => setStep(s => s - 1)}>上一步</Button>:null}<Button variant={step === 3 ? 'danger':'primary'} disabled={step === 2 ? !sent || code !== '123456' : step === 3 ? !checks.every(Boolean) || phrase !== 'DELETE_MY_ACCOUNT':false} onClick={() => {if(step < 3) setStep(s => s + 1);else {setStep(0);setSigned(false);setNotice('注销申请已提交。');}}}>{step === 3 ? '提交注销':'继续'}</Button></SettingsActions><SettingsFeedback>{notice}</SettingsFeedback>
  </div>;
  return <>
    <SettingsSection title={signed ? '已登录':'未登录'}><SettingsRow title={signed ? '张明':'本地模式'} help={signed ? '账号 zhangming · 手机号未绑定':'本机内容保留，登录后管理设备。'}><Button onClick={() => {if(signed) document.getElementById('preview-account-devices')?.scrollIntoView({behavior:'smooth',block:'start'});else {setSigned(true);setNotice('已登录。');}}}>{signed ? '管理账号':'登录账号'}</Button></SettingsRow></SettingsSection>
    {signed ? <><div id="preview-account-devices" /><SettingsSection title="登录设备">{devices.map((name,i) => <SettingsRow key={name} title={name} help="最近活跃"><span className="cs-settings-muted">{i === 0 ? '当前设备':null}</span>{i !== 0 ? <Button size="sm" onClick={() => setConfirm({title:`撤销「${name}」的访问权限？`,label:'撤销访问',action:() => setDevices(d => d.filter(n => n !== name))})}>撤销访问</Button>:null}</SettingsRow>)}</SettingsSection>
    <SettingsActions><Button onClick={() => setConfirm({title:'退出当前账号？本地内容将保留。',label:'退出登录',action:() => setSigned(false)})}>退出登录</Button><Button variant="danger" onClick={() => {setStep(1);setCode('');setSent(false);setPhrase('');setChecks([false,false,false]);setNotice('');}}>注销账号</Button></SettingsActions></> : null}
    {confirm ? <SettingsConfirm title={confirm.title} confirmLabel={confirm.label} onCancel={() => setConfirm(null)} onConfirm={() => {confirm.action();setConfirm(null);setNotice('操作已完成。');}} />:null}<SettingsFeedback>{notice}</SettingsFeedback>
  </>;
}
function SettingsSecurity() {
  const [rows,setRows] = React.useState([{id:'finance-check',name:'项目报告口径核验',decision:'通过',score:96,time:'2026-09-05 09:30'},{id:'material-check',name:'调研材料清单',decision:'有提示',score:78,time:'2026-09-05 09:30'}]);
  const [query,setQuery] = React.useState(''), [picker,setPicker] = React.useState(false), [all,setAll] = React.useState(false), [notice,setNotice] = React.useState(''), [busy,setBusy] = React.useState('');
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const recheck = id => {setBusy(id);setNotice('正在检查…');timer.current = setTimeout(() => {setRows(old => old.map(r => r.id === id ? {...r,time:'刚刚'}:r));setBusy('');setNotice('检查已完成。');},600);};
  const exportRows = () => {const url = URL.createObjectURL(new Blob([JSON.stringify({preview:true,receipts:rows},null,2)],{type:'application/json'}));const a = document.createElement('a');a.href=url;a.download='preview-security-receipts.json';a.click();setTimeout(() => URL.revokeObjectURL(url),1000);setNotice('检查回执已导出。');};
  return <><SettingsSection title="系统保护"><SettingsRow title="系统保护已开启"><span className="cs-settings-muted">已开启</span></SettingsRow>{[['安全扫描器','可用 · 完整性已校验'],['深扫引擎','规则包已校验'],['完整性校验引擎','已校验']].map(([title,help]) => <SettingsRow key={title} title={title} help={help}><span className="cs-settings-muted">只读</span></SettingsRow>)}</SettingsSection>
    <SettingsSection title="最近检查记录"><p className="cs-settings-muted">安全通过不代表已验证有效。</p><div className="cs-settings-table"><DataTable columns={[{key:'name',label:'技能',width:'1.4fr'},{key:'decision',label:'结论'},{key:'score',label:'评分',width:'.6fr'},{key:'time',label:'检查时间'},{key:'action',label:'操作'}]} rows={(all ? rows:rows.slice(0,10)).map(r => ({...r,action:<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => recheck(r.id)}>{busy === r.id ? '检查中…':'重新检查'}</Button>}))} /></div>{rows.length > 10 ? <Button onClick={() => setAll(v => !v)}>{all ? '查看最近':'查看全部'}</Button>:null}</SettingsSection>
    <SettingsActions><Button onClick={exportRows}>导出检查回执（脱敏）</Button><Button onClick={() => setPicker(v => !v)}>{picker ? '收起技能检查':'检查单个技能'}</Button><Button disabled={!!busy} onClick={() => {setNotice('状态已刷新。');}}>刷新</Button></SettingsActions>
    {picker ? <div className="cs-settings-editor"><Input aria-label="搜索已安装技能" placeholder="搜索已安装技能" value={query} onChange={e => setQuery(e.target.value)} />{rows.filter(r => `${r.name} ${r.id}`.includes(query.trim())).map(r => <SettingsRow key={r.id} title={r.name} help={r.id}><Button disabled={!!busy} onClick={() => recheck(r.id)}>检查</Button></SettingsRow>)}{!rows.some(r => `${r.name} ${r.id}`.includes(query.trim())) ? <p className="cs-settings-muted">没有匹配的技能</p>:null}</div>:null}
    <SettingsFeedback>{notice}</SettingsFeedback><p className="cs-settings-muted">技能安装、导入与生成都会经过安全检查；检查不可用时，新内容不会被当作已检查放行。</p>
  </>;
}
function SettingsAbout() {
  const [state,setState] = React.useState('idle'), [progress,setProgress] = React.useState(0), [notice,setNotice] = React.useState('');
  const timer = React.useRef(null);
  React.useEffect(() => () => clearInterval(timer.current), []);
  const download = () => {setState('downloading');setProgress(0);let n=0;timer.current=setInterval(() => {n+=25;setProgress(n);if(n === 100){clearInterval(timer.current);setState('ready');}},200);};
  return <><SettingsSection title="CogSeed"><SettingsRow title="桌面应用"><SettingsActions><Button disabled={['checking','downloading'].includes(state)} onClick={() => {setState('checking');timer.current=setTimeout(() => setState('available'),500);}}>{state === 'checking' ? '正在检查…':'检查更新'}</Button><a className="cs-settings-external" href="https://hub.example.com/#view=changelog" target="_blank" rel="noopener noreferrer">版本介绍</a></SettingsActions></SettingsRow></SettingsSection>
    {state === 'available' ? <SettingsSection title="发现可用更新"><SettingsRow title="新版本安装包"><SettingsActions><Button onClick={download}>下载更新</Button><Button onClick={() => {setState('idle');setNotice('已跳过此版本。');}}>跳过此版本</Button></SettingsActions></SettingsRow></SettingsSection>:null}
    {state === 'downloading' ? <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="下载进度"><p>正在下载 · {progress}%</p><div className="cs-settings-progress"><span style={{width:`${progress}%`}} /></div></div>:null}
    {state === 'ready' ? <SettingsSection title="下载完成"><SettingsRow title="安装包已就绪"><SettingsActions><Button onClick={() => setNotice('请打开安装包继续安装。')}>打开安装包</Button><Button variant="primary" onClick={() => setNotice('准备重启并安装。')}>重启并安装</Button></SettingsActions></SettingsRow></SettingsSection>:null}<SettingsFeedback>{notice}</SettingsFeedback>
  </>;
}
Object.assign(window,{SettingsChoice,SettingsActions,SettingsFeedback,SettingsConfirm,SettingsGeneral,SettingsUsage,SettingsAccount,SettingsSecurity,SettingsAbout});

// Source: settings.js::_settingsRenderRecycle. Sample snapshots only.
function SettingsRecycle() {
  const [items,setItems] = React.useState([{id:'task',name:'项目调研核验',kind:'任务',count:3},{id:'file',name:'项目台账草稿.md',kind:'资料',count:1}]);
  const [pending,setPending] = React.useState(null), [notice,setNotice] = React.useState('');
  return <SettingsSection title="回收站">{items.length ? items.map(item => <SettingsRow key={item.id} title={item.name} help={`${item.kind} · ${item.count} 项 · 删除于 2026-09-05 09:30`}><SettingsActions><Button onClick={() => {setItems(old => old.filter(x => x.id !== item.id));setNotice(`已恢复 ${item.count} 项数据。`);}}>恢复</Button><Button onClick={() => setPending(item)}>彻底删除</Button></SettingsActions></SettingsRow>) : <p className="cs-settings-muted">暂无可恢复数据</p>}{pending ? <SettingsConfirm title={`彻底删除「${pending.name}」？删除后不可恢复。`} onCancel={() => setPending(null)} onConfirm={() => {setItems(old => old.filter(x => x.id !== pending.id));setPending(null);setNotice('已彻底删除。');}} /> : null}<SettingsFeedback>{notice}</SettingsFeedback></SettingsSection>;
}
window.SettingsRecycle = SettingsRecycle;

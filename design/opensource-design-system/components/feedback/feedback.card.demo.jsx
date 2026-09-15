const { InlineConfirm, StatusPill, StatusDot, StatusCapsule, Alert, Toast, InlineAuthBar, StepList, ProgressBar, Spinner, Skeleton, EmptyState, Dialog, Popover, PopoverItem, Button, Tooltip, Checkbox, Input, Field, Select } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [formOpen,setFormOpen]=React.useState(false), [title,setTitle]=React.useState(''), [frequency,setFrequency]=React.useState('每天');
  const anchorRef=React.useRef(null);
  const [panelOpen,setPanelOpen]=React.useState(false);
  const [permission,setPermission]=React.useState('请求批准');
  const [auth,setAuth]=React.useState('ask'), [dlg,setDlg]=React.useState(false), [cc,setCc]=React.useState(false);
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:"var(--cs-space-4) var(--cs-space-6)",position:'relative'}}>
      <div className="cs-col">
        <div className="cs-row">
          <StatusPill tone="success" check>已完成</StatusPill>
          <StatusPill tone="attention">运行中 · 4/7</StatusPill>
          <StatusPill tone="critical">已失败</StatusPill>
          <StatusPill>已归档</StatusPill>
        </div>
        <div className="cs-row" style={{gap:"var(--cs-space-4)"}}>
          <StatusCapsule tone="success">数据不出域</StatusCapsule>
          <StatusDot tone="attention" label="运行中" />
          <StatusDot label="空闲" />
        </div>
        <div className="cs-row" style={{gap:"var(--cs-space-3)"}}>
          <span style={{fontSize: 'var(--cs-size-ui-sm)',color:'var(--cs-ink-70)'}}>4 / 7</span>
          <ProgressBar value={4} max={7} maxWidth={200} />
          <Spinner size={13} /><Spinner size={16} tone="attention" />
        </div>
        <StepList steps={[
          {label:'读取文件 · 项目台账_2026Q3.xlsx',state:'done',meta:'0.8s'},
          {label:'筛选 · 命中 137 条',state:'running',meta:'运行中'},
          {label:'按项目组汇总',state:'wait',meta:'待执行'}
        ]} />
        <InlineAuthBar state={auth} time="14:04" message="需要访问「客户经理通讯录」才能填入收件人"
          onAllow={()=>setAuth('granted')} onDeny={()=>setAuth('denied')} />
      </div>
      <div className="cs-col">
        <InlineConfirm title="删除这项密钥配置？" confirmLabel="删除配置" onCancel={()=>{}} onConfirm={()=>{}} />
        <Alert title="口径说明" onClose={()=>{}}>预算为本金余额，不含表外与承诺未提用额度。</Alert>
        <Alert tone="attention" title="3 户缺少最新项目报告" action="查看这 3 户">已用上期数据估算，结果标注为待核。</Alert>
        <Alert tone="critical" title="数仓连接中断" action="重试">14:07 起连接超时，任务已在第 5 步暂停。</Alert>
        <Toast title="简报已存入华东团队空间" meta="v3 · 14:12 · 3 人可见" onClose={()=>{}} />
        <div className="cs-row" style={{alignItems:'flex-start',gap:"var(--cs-space-4)"}}>
          <div ref={anchorRef} style={{position:'relative'}}>
            <Button onClick={()=>setPanelOpen(v=>!v)} aria-expanded={panelOpen}>{permission}</Button>
            <Popover open={panelOpen} onOpenChange={setPanelOpen} anchorRef={anchorRef} label="访问权限" width={180}>
              {['完全访问','帮我批准','请求批准'].map(mode=><PopoverItem key={mode} label={mode} selected={permission===mode}
                onClick={()=>{setPermission(mode);setPanelOpen(false);}} />)}
            </Popover>
          </div>
          <Popover title="权限范围" badge="只读" footer="由管理员在连接器策略中配置">
            项目存贷 · 客户 · 账户三个主题域<br/>查询走脱敏视图，结果不落盘
          </Popover>
          <div className="cs-col" style={{flex:1,gap:"var(--cs-space-3)"}}>
            <Tooltip label="数据不出域 · 查询在行内网执行"><StatusCapsule tone="success">悬停看 tooltip</StatusCapsule></Tooltip>
            <Skeleton lines={[62,100,88]} />
            <EmptyState title="这个空间还没有产物" reason="任务完成后在产物页选择「存入空间」。" action="新建任务" />
            <Button onClick={()=>setFormOpen(true)}>打开表单对话框</Button>
            <Button variant="danger" onClick={()=>setDlg(true)}>打开确认对话框</Button>
          </div>
        </div>
      </div>
      {formOpen&&<Dialog title="新建自动化任务" confirmLabel="创建" initialFocus="first" showClose confirmDisabled={!title.trim()} onCancel={()=>setFormOpen(false)} onConfirm={()=>setFormOpen(false)}>
        <div className="cs-col"><Field label="任务内容"><Input value={title} onChange={e=>setTitle(e.target.value)} /></Field><Field label="频率"><Select options={['不重复','每天','每周','每月']} value={frequency} onChange={setFrequency}/></Field></div>
      </Dialog>}
      {dlg ? <Dialog danger title="删除任务与全部产物？" confirmLabel="删除" onCancel={()=>setDlg(false)} onConfirm={()=>setDlg(false)}
        description="「项目里程碑与提醒」及其 3 份产物将被移出空间。审计留痕会保留 180 天，产物本身不可恢复。"
        extra={<Checkbox checked={cc} onChange={setCc} label="同时通知已抄送人" />} /> : null}
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

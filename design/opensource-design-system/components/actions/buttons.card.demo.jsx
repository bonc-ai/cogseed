const { Button, IconButton, Icon } = window.CogSeedDesignSystem_f581b5;
function Demo(){
  const [busy,setBusy]=React.useState(false);
  React.useEffect(()=>{if(!busy)return;const timer=setTimeout(()=>setBusy(false),1200);return()=>clearTimeout(timer);},[busy]);
  return (
  <div className="cs-col" style={{gap:"var(--cs-space-3)"}}>
    <div className="cs-row">
      <Button variant="primary" icon={<Icon name="plus" size={14} />}>新建空间</Button>
      <Button>次操作</Button><Button variant="suggestion">项目材料核对</Button>
      <Button variant="ghost">文字按钮</Button>
      <Button variant="danger">危险操作</Button>
      <Button disabled>禁用</Button>
      <Button variant="primary" loading={busy} onClick={()=>setBusy(true)}>提交材料</Button>
    </div>
    <div className="cs-row">
      <Button variant="primary" size="login">登录</Button><Button size="sm">28 sm</Button><Button size="md">32 md</Button><Button size="lg">36 lg</Button>
      <span style={{width:1,height:18,background:'var(--cs-border-field)'}}></span>
      <IconButton size="sm" variant="quiet"><Icon name="plus" size={15} /></IconButton>
      <IconButton><Icon name="plus" size={14} /></IconButton>
      <IconButton variant="accent"><Icon name="send" size={15} /></IconButton>
      <IconButton disabled><Icon name="send" size={15} /></IconButton>
      <Button variant="ink">允许一次</Button>
      <Button variant="dangerSolid">删除</Button>
    </div>
    <div style={{fontSize: 'var(--cs-size-caption)',color:'var(--cs-ink-45)'}}>业务页面一屏最多一个主要操作按钮；这里并列展示不同组件状态。Tab 检查焦点，点击提交材料检查加载状态。</div>
  </div>
);}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

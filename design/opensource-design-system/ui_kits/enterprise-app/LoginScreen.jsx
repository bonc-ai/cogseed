const { PageFrame, PageHeader } = window;
const { Button } = window.CogSeedDesignSystem_f581b5;
function LoginScreen({onLogin}) {
  return <PageFrame><PageHeader windowControls style={{borderBottom:0,padding:"0 var(--cs-space-4)"}} />
    <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:"var(--cs-space-6)",paddingBottom:'var(--cs-titlebar-height)'}}>
      <img src="../../assets/brand/logo.png" width="64" height="64" alt="" draggable="false" />
      <h1 style={{margin:0,font:'400 32px/1.2 var(--cs-font-sans)',letterSpacing:'-.02em'}}>CogSeed</h1>
      <Button variant="primary" size="login" onClick={onLogin}>登录</Button>
    </div>
  </PageFrame>;
}
Object.assign(window,{LoginScreen});

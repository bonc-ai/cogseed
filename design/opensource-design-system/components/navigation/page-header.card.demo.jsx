const {PageHeader, Button, IconButton, Icon, StatusPill} = window.CogSeedDesignSystem_f581b5;
function Demo() {
  const [notice,setNotice] = React.useState('');
  return <main>
    <section><p className="sample-label">基础标题</p><PageHeader title="认知资产" /></section>
    <section><p className="sample-label">右侧操作</p><PageHeader title="工作空间" actions={<Button onClick={()=>setNotice('新建空间')}>新建空间</Button>} /></section>
    <section><p className="sample-label">返回与状态</p><PageHeader title="整理到期项目" leading={<IconButton aria-label="返回" onClick={()=>setNotice('返回')}><Icon name="chevronLeft" /></IconButton>} status={<StatusPill tone="success">已完成</StatusPill>} /></section>
    <section style={{maxWidth:420}}><p className="sample-label">长标题</p><PageHeader title="整理华东各项目组未来六十天到期项目与补充项目报告清单" actions={<Button onClick={()=>setNotice('查看详情')}>查看</Button>} /></section>
    <div role="status">{notice}</div>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

const { SettingsSection, Button, Switch } = window.CogSeedDesignSystem_f581b5;
function Demo() {
  const [enabled,setEnabled] = React.useState(true), [notice,setNotice] = React.useState('');
  return <main><h1>设置分组</h1>
    <SettingsSection title="记忆"><div className="sample-row"><span>个人记忆</span><Button onClick={() => setNotice('管理记忆入口')}>管理记忆</Button></div></SettingsSection>
    <SettingsSection title="通用"><div className="sample-row"><span>任务通知</span><Switch aria-label="任务通知" checked={enabled} onChange={setEnabled} /></div><div className="sample-row"><span>默认推理强度</span><span className="sample-status">自动</span></div></SettingsSection>
    <p className="sample-status" role="status">{notice}</p>
  </main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<Demo />);

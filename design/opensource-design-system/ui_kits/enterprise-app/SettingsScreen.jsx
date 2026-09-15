const { SettingsSection, Button, Icon, NavItem } = window.CogSeedDesignSystem_f581b5;

function SettingsRow({ title, help, children }) {
  return <div className="cs-settings-row"><div className="cs-settings-row-copy"><div className="cs-settings-row-title">{title}</div>{help ? <p>{help}</p> : null}</div><div className="cs-settings-row-control">{children}</div></div>;
}
const SETTINGS_SECTIONS = [
  ['data','数据','database'], ['account','账号','lock'],
  ['usage','账号与用量','clock'], ['general','通用','settings'],
  ['security','安全与信任','shield'], ['about','关于我们','info']
];
function readSettingsSection() {
  const value = new URLSearchParams(window.location.search).get('section');
  return SETTINGS_SECTIONS.some(([id]) => id === value) ? value : 'data';
}
function SettingsScreen({ onBack, onLibrary }) {
  const [section, setSection] = React.useState(readSettingsSection);
  const [detail, setDetail] = React.useState(() => readSettingsSection() === 'data' && new URLSearchParams(location.search).get('detail') === 'memory');
  React.useEffect(() => {
    const restore = () => {setSection(readSettingsSection());setDetail(readSettingsSection() === 'data' && new URLSearchParams(location.search).get('detail') === 'memory');};
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const select = id => {
    setDetail(false);setNotice('');
    if (id !== section || detail) {
      const url = new URL(window.location.href);url.searchParams.set('section',id);url.searchParams.delete('detail');
      window.history.pushState(null,'',url);setSection(id);
    }
  };
  React.useEffect(() => {const pane=document.querySelector('.cs-settings-scroll');if(pane)pane.scrollTop=0;},[section,detail]);
  const [memory, setMemory] = React.useState(() => JSON.parse(JSON.stringify(window.MEMORY_PREVIEW)));
  const [notice, setNotice] = React.useState('');
  const openMemory = active => {const url = new URL(location.href);active ? url.searchParams.set('detail','memory') : url.searchParams.delete('detail');history.pushState(null,'',url);setDetail(active);};
  const preview = title => setNotice(`请在文件管理器中查看${title}`);
  return <PageFrame className="cs-settings-screen">
    <PageHeader windowControls title="设置" />
    <div className="cs-settings-layout">
      <aside className="cs-settings-nav">
        <Button variant="ghost" icon={<Icon name="chevronLeft" size={14} />} onClick={onBack} style={{ justifyContent: 'flex-start', width: '100%', marginBottom: "var(--cs-space-6)" }}>返回应用</Button>
        <nav aria-label="设置分类">
          {SETTINGS_SECTIONS.map(([id,label,icon]) => <NavItem key={id} icon={<Icon name={icon} />} label={label} selected={section === id} aria-current={section === id ? 'page':undefined} onClick={() => select(id)} />)}
        </nav>
      </aside>
      <PageScroll className="cs-settings-scroll">
        <div className="cs-settings-content">
          <div hidden={section !== 'data'}>
          {detail ? <MemorySettings value={memory} onChange={setMemory} onBack={() => openMemory(false)} /> : <>
          <div className="cs-settings-heading"><h1>数据</h1></div>
          <div className="cs-settings-notice" role="status" aria-live="polite">{notice}</div>
          <SettingsSection title="记忆">
            <SettingsRow title="个人记忆" help="管理跨任务使用的个人记忆。"><Button onClick={() => { setNotice(''); openMemory(true); }}>管理记忆</Button></SettingsRow>
          </SettingsSection>
          <SettingsSection title="本地">
            <SettingsRow title="资料库" help="管理可供模型引用的资料内容。"><Button onClick={onLibrary}>打开资料库</Button></SettingsRow>
            <SettingsRow title="数据目录" help="在系统文件管理器中查看应用数据。"><Button onClick={() => preview('数据目录')}>打开目录</Button></SettingsRow>

          </SettingsSection>
          <SettingsRecycle />
          </>}
          </div>
          {SETTINGS_SECTIONS.filter(([id]) => id !== 'data').map(([id,label]) => <div key={id} hidden={section !== id}>
            <div className="cs-settings-heading"><h1>{label}</h1></div>
            {id === 'account' ? <SettingsAccount /> : id === 'usage' ? <SettingsUsage /> : id === 'general' ? <SettingsGeneral /> : id === 'security' ? <SettingsSecurity /> : <SettingsAbout />}
          </div>)}
        </div>
      </PageScroll>
    </div>
  </PageFrame>;
}
Object.assign(window, { SettingsScreen, SettingsRow, SETTINGS_SECTIONS, readSettingsSection });

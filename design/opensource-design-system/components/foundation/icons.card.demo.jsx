const { Icon, csIcons } = window.CogSeedDesignSystem_f581b5;
const names = Object.keys(csIcons);
ReactDOM.createRoot(document.getElementById('root')).render(
  <div className="cs-col" style={{gap:"var(--cs-space-3)"}}>
    <div style={{display:'grid',gridTemplateColumns:'repeat(16,1fr)',gap:"var(--cs-space-3)",color:'var(--cs-ink-70)'}}>
      {names.map(n => <Icon key={n} name={n} size={20} />)}
    </div>
    <div className="cs-row" style={{gap:"var(--cs-space-6)"}}>
      <span className="cs-row" style={{gap:"var(--cs-space-2)",color:'var(--cs-ink-70)'}}><Icon name="check" size={13} /><Icon name="check" size={16} /><Icon name="check" size={20} /><span style={{font:'var(--cs-type-numeric)',color:'var(--cs-ink-45)'}}>13 / 16 / 20</span></span>
      <span className="cs-row" style={{gap:"var(--cs-space-2)"}}><Icon name="check" size={16} color="var(--cs-success)" /><Icon name="warning" size={16} color="var(--cs-attention)" /><Icon name="error" size={16} color="var(--cs-critical)" /><span style={{font:'var(--cs-type-numeric)',color:'var(--cs-ink-45)'}}>状态色仅用于状态图标</span></span>
    </div>
    <div style={{fontSize: 'var(--cs-size-caption)',color:'var(--cs-ink-45)'}}>共 {names.length} 个图标 · 不使用填充图标、彩色图标或 emoji</div>
  </div>
);

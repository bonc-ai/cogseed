const { CollapsedSidebarControls, TrafficLights } = window;
function PageFrame({className = '', home = false, children, style}) {
  return <main className={className} style={{flex:1,display:'flex',flexDirection:'column',minWidth:0,minHeight:0,position:'relative',background:'var(--cs-white)',...style}}>
    {home ? <div className="cs-home-mist" aria-hidden="true" /> : null}{children}
  </main>;
}
function PageHeader({collapsed, onExpand, windowControls = false, leading, className = '', ...props}) {
  const SharedPageHeader = window.CogSeedDesignSystem_f581b5.PageHeader;
  return <SharedPageHeader {...props} className={'cs-app-titlebar '+className} data-sidebar-collapsed={collapsed ? 'true' : undefined}
    leading={(collapsed || windowControls || leading) ? <>{collapsed ? <CollapsedSidebarControls onExpand={onExpand} /> : windowControls ? <TrafficLights /> : null}{leading}</> : undefined} />;
}
function PageScroll({className = '', children, style}) {
  return <div className={className} data-cs-scroll style={{position:'relative',flex:1,minHeight:0,overflow:'auto',overscrollBehavior:'contain',...style}}>{children}</div>;
}
// Page-level navigation: one scrollable row with an optional fixed action slot.
function PageTabs({items, value, onChange, actions, ariaLabel}) {
  const SharedTabs = window.CogSeedDesignSystem_f581b5.Tabs;
  return <div className="cs-page-tabs">
    <div className="cs-page-tabs-scroll"><SharedTabs items={items} value={value} onChange={onChange} ariaLabel={ariaLabel} style={{borderBottom:0}} /></div>
    {actions ? <div className="cs-page-tabs-actions">{actions}</div> : null}
  </div>;
}
Object.assign(window,{PageFrame,PageHeader,PageScroll,PageTabs});

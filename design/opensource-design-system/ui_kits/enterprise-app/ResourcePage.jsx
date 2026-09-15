const { PageFrame, PageHeader, PageScroll } = window;
const { Button, Input, SegmentedControl, Icon } = window.CogSeedDesignSystem_f581b5;
// Page composition: leading context, then a right-aligned search/action cluster.
function ResourceToolbar({leading, search, actions}) {
  return <div className="cs-resource-toolbar">{leading && <div className="cs-resource-toolbar-leading">{leading}</div>}<div className="cs-resource-toolbar-controls">{search && <div className="cs-resource-toolbar-search">{search}</div>}{actions}</div></div>;
}
function ResourcePage({title, collapsed, onExpand, action, onAction, query, onQuery, filters, filter, onFilter, count, notice, children}) {
  return <PageFrame>
    <PageHeader collapsed={collapsed} onExpand={onExpand} title={title} actions={action && <Button icon={<Icon name="plus" />} onClick={onAction}>{action}</Button>} />
    <PageScroll className="cs-resource-page-scroll"><div className="cs-resource-page-content">
      <ResourceToolbar leading={filters?.length > 0 && <SegmentedControl items={filters} value={filter} onChange={onFilter}/>} search={<Input size="md" icon="search" aria-label={`搜索${title}`} placeholder="搜索名称或说明" value={query} onChange={e=>onQuery(e.target.value)}/>}/>
      <div className="cs-resource-page-caption"><span>{count} 项</span></div>
      {notice && <p className="cs-resource-page-notice" role="status">{notice}</p>}
      {children}
    </div></PageScroll>
  </PageFrame>;
}
function PreviewNameEditor({title, initial = '', onSave, onCancel}) {
  const [value, setValue] = React.useState(initial);
  return <form className="cs-preview-editor" onSubmit={e => {e.preventDefault(); if(value.trim()) onSave(value.trim());}}>
    <label htmlFor="preview-name">{title}</label>
    <Input id="preview-name" autoFocus value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => {if(e.isComposing || e.keyCode === 229) {if(e.key === 'Enter') e.preventDefault();}}} />
    <div className="cs-resource-page-toolbar"><Button type="submit" disabled={!value.trim()}>保存名称</Button><Button onClick={onCancel}>取消</Button></div>
  </form>;
}
Object.assign(window, {ResourceToolbar, ResourcePage, PreviewNameEditor});

import React from 'react';

// Shared page chrome. Business state and window controls belong to callers.
export function PageHeader({title, leading, status, actions, children, className = '', style, ...props}) {
  return <header {...props} className={'cs-page-header '+className} style={style}>
    {leading && <div className="cs-page-header__leading">{leading}</div>}
    {title != null && <h1 className="cs-page-header__title" title={typeof title === 'string' ? title : undefined}>{title}</h1>}
    {status && <div className="cs-page-header__status">{status}</div>}
    {children}
    {actions && <div className="cs-page-header__actions">{actions}</div>}
  </header>;
}

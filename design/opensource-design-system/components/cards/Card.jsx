import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { DropdownMenu } from '../navigation/DropdownMenu.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Button } from '../actions/Button.jsx';

export function Card({ padding = 16, variant = 'default', hoverable, children, style, onClick, layout = 'tile', className = '' }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className={`cs-card cs-card--${layout} ${className}`} onClick={onClick}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? e => { if (!e.isComposing && e.keyCode !== 229 && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } } : undefined}
      onMouseEnter={hoverable || onClick ? () => setHover(true) : undefined}
      onMouseLeave={hoverable || onClick ? () => setHover(false) : undefined}
      style={{
        padding, background: variant === 'subtle' ? 'var(--cs-surface-subtle)' : 'var(--cs-white)', borderRadius: 'var(--cs-radius-card)',
        border: '1px solid ' + (hover ? 'var(--cs-border-strong)' : 'var(--cs-border)'),
        '--cs-card-shadow': hover ? 'var(--cs-shadow-lg)' : variant === 'subtle' ? 'none' : 'var(--cs-shadow-sm)',
        cursor: hoverable || onClick ? 'pointer' : 'default', boxSizing: 'border-box',
        transition: 'box-shadow var(--cs-dur-hover) var(--cs-ease-out),border-color var(--cs-dur-hover) var(--cs-ease-out)', ...style
      }}>{children}</div>
  );
}

export function CardFooter({ children, style }) {
  return (
    <>
      <div style={{ height: 1, background: 'var(--cs-border-hairline)', margin: "var(--cs-space-3) 0 var(--cs-space-3)" }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", ...style }}>{children}</div>
    </>
  );
}

export function GroupHeading({ label, action, rule = true, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: "var(--cs-space-2)", ...style }}>
      <span style={{ font: 'var(--cs-type-label)', letterSpacing: 'var(--cs-tracking-label)', textTransform: 'uppercase', color: 'var(--cs-text-placeholder)' }}>{label}</span>
      {rule ? <span style={{ flex: 1, height: 1, background: 'var(--cs-border-hairline)' }} /> : null}
      {action ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--cs-space-1)", fontSize: 'var(--cs-size-ui-sm)', color: 'var(--cs-ink-45)', cursor: 'pointer' }}>{action}<Icon name="chevronRight" size={13} /></span> : null}
    </div>
  );
}

/** Shared resource structure. Business status and actions are supplied by callers. */
export function ResourceCard({ variant = 'capability', layout = 'tile', icon = 'file', title, description, status, action, onAction, disabled, loading, control, menu, workspace, automation, onToggleRuns, onOpen, children }) {
  if(variant==='automation' && automation) return <Card layout="row" className="cs-resource-card cs-resource-card--automation cs-automation-card">
    <div className="cs-automation-card-main">
      <Button variant="ghost" size="sm" aria-label={`执行任务（${automation.runCount || 0}）`} aria-expanded={!!automation.expanded} onClick={onToggleRuns}><Icon name={automation.expanded?'chevronDown':'chevronRight'} size={16}/><span>{automation.runCount || 0}</span></Button>
      <div className="cs-automation-card-content"><h3><button className="cs-resource-title-action" onClick={onToggleRuns}>{title}</button></h3><div className="cs-automation-card-caption">{description&&<span>{description}</span>}<small>{automation.device}</small>{status}</div></div>
      <dl className="cs-automation-card-schedule"><div><dt>计划</dt><dd>{automation.schedule}</dd></div><div><dt>最近运行</dt><dd>{automation.lastRun || '尚未运行'}</dd></div></dl>
      {menu&&<DropdownMenu align="end" groups={menu.groups} trigger={<IconButton variant="quiet" size="sm" title={`${description || title} · 更多操作`}><Icon name="dots" size={16}/></IconButton>}/>}
      {control}{action&&<Button size="sm" disabled={disabled} loading={loading} onClick={onAction}>{action}</Button>}
    </div>
    {children&&<div className="cs-automation-card-details">{children}</div>}
  </Card>;
  return <Card layout={layout} className={`cs-resource-card cs-resource-card--${variant}`}>
    <div className="cs-resource-head">
      <span className="cs-resource-icon"><Icon name={icon} size={18} /></span>
      <div className="cs-resource-heading"><h3>{onOpen ? <button className="cs-resource-title-action" onClick={onOpen}>{title}</button> : title}</h3>{variant === 'workspace' && workspace?.updatedAt && <small>{workspace.updatedAt}</small>}{variant === 'automation' && automation?.device && <small>{automation.device}</small>}</div>
      {(control || menu) && <div className="cs-resource-control">{control}
        {menu && <DropdownMenu align="end" header={menu.details?.length ? <dl className="cs-resource-menu-details">{menu.details.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : null}
          groups={menu.groups} trigger={<IconButton variant="quiet" size="sm" title={`${title} · 更多操作`} aria-label={`${title} · 更多操作`}><Icon name="dots" size={16} /></IconButton>} />}
      </div>}
    </div>
    {description && <p className="cs-resource-description">{description}</p>}
    {variant === 'workspace' && workspace?.roles?.length > 0 && <p className="cs-resource-workspace-roles">{workspace.roles.join('、')}</p>}
    {variant === 'automation' && automation && <dl className="cs-resource-automation-meta"><div><dt>计划</dt><dd>{automation.schedule}</dd></div><div><dt>最近运行</dt><dd>{automation.lastRun || '尚未运行'}</dd></div></dl>}
    <div className="cs-resource-footer"><CardFooter>
      <div className="cs-resource-status">{variant === 'workspace' && workspace ? <><small>最近</small><span className="cs-resource-recent-task">{workspace.recentTask || '暂无最近任务'}</span></> : status}</div>
      {variant === 'automation' && automation && <Button size="sm" aria-expanded={!!automation.expanded} onClick={onToggleRuns}>执行任务（{automation.runCount || 0}）</Button>}
      {action && <Button size="sm" disabled={disabled} loading={loading} onClick={onAction}>{action}</Button>}
    </CardFooter></div>
    {children}
  </Card>;
}

export function CardGrid({ children }) {
  return <div className="cs-card-grid">{children}</div>;
}

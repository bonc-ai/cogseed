import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { Button } from '../actions/Button.jsx';

export function ComposerNotice({ message, action, onAction, tone = 'info' }) {
  return <div className={'cs-composer-notice ' + (tone === 'error' ? 'is-error' : '')} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon name={tone === 'error' ? 'warning' : 'info'} size={14}/><span>{message}</span>
    {action && <Button size="sm" variant="ghost" onClick={onAction}>{action}</Button>}
  </div>;
}

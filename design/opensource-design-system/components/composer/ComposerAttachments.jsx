import React from 'react';
import { Button } from '../actions/Button.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Icon } from '../foundation/Icon.jsx';
import { Spinner } from '../feedback/ProgressBar.jsx';

export function ComposerAttachments({ items = [], onRemove, onAdd, dragging = false }) {
  return <div className={'cs-attachments-panel' + (dragging ? ' is-dragging' : '')}>
    {dragging && <div className="cs-drop-hint"><Icon name="upload" size={16}/>松开鼠标，添加文件</div>}
    <div className="cs-attachment-list" role="region" aria-label="附件，左右滚动查看" tabIndex={items.length ? 0 : undefined}>
      {items.map(item => {
        const hint = item.status === 'error' ? (item.error || '上传失败，请移除后重新添加') : item.status === 'uploading' ? '正在上传' : item.video ? '仅供查看，不参与模型分析' : '';
        return <div key={item.id} title={[item.name,hint].filter(Boolean).join(' · ')} className={'cs-attachment-item ' + (item.status === 'error' ? 'is-error' : '')}>
          <Icon name="fileText" size={14}/><span className="cs-attachment-name">{item.name}</span>
          {item.status === 'uploading' ? <span role="status" aria-label={'正在上传' + item.name}><Spinner size={12}/></span> :
            <IconButton size="sm" variant="quiet" disabled={!onRemove} title={'移除' + item.name} onClick={()=>onRemove?.(item.id)}><Icon name="close" size={12}/></IconButton>}
        </div>;
      })}
      {onAdd && <Button size="sm" variant="ghost" onClick={onAdd}>添加文件</Button>}
    </div>
  </div>;
}

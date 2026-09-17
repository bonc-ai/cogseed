import React from 'react';
import { IconButton } from '../actions/IconButton.jsx';
import { Icon } from '../foundation/Icon.jsx';

// A local interaction specimen: stores no hidden identifiers or client draft data.
export function ComposerRichDraft({ onTextChange }) {
  const ref = React.useRef(null);
  const emit = () => onTextChange?.(ref.current?.innerText || '');
  const paste = e => {
    e.preventDefault();
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!ref.current?.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(e.clipboardData.getData('text/plain'));
    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range); emit();
  };
  return <div ref={ref} className="cs-rich-draft" role="textbox" aria-label="包含技能标签的正文" aria-multiline="true"
    contentEditable suppressContentEditableWarning onInput={emit} onPaste={paste}
    onCopy={e => { e.clipboardData.setData('text/plain', window.getSelection()?.toString() || ''); e.preventDefault(); }}>
    请使用 <span className="cs-inline-token" contentEditable={false}>@项目材料核对<IconButton title="移除技能标签" size="sm" variant="quiet"
      onClick={e => { e.currentTarget.parentElement.remove(); emit(); }}><Icon name="close" size={12}/></IconButton></span> 核对这份清单，并列出缺失材料。
  </div>;
}

import React from 'react';
import { Icon } from '../foundation/Icon.jsx';
import { Spinner } from '../feedback/ProgressBar.jsx';
import { IconButton } from '../actions/IconButton.jsx';
import { Input } from '../forms/Input.jsx';
import { Button } from '../actions/Button.jsx';
import { Popover, PopoverItem } from '../feedback/Popover.jsx';
import { ComposerMentionPicker, COMPOSER_EXAMPLES, MENTION_LABELS } from './ComposerMentionPicker.jsx';

const PERMISSIONS = ['完全访问', '帮我批准', '请求批准'];
const SPACE_EXAMPLES = [{id:'east',name:'华东团队空间'}, {id:'risk',name:'风险审查空间'}, {id:'clients',name:'客户经营空间'}];
const EFFORTS = ['自动', '关闭', '低', '高'];

// Composer entry chrome is shared; height remains owned by Button size="sm".
function ComposerTrigger({ open = false, onClick, label, compactIcon, children }) {
  const [hover, setHover] = React.useState(false);
  return <Button className="cs-composer-trigger" title={label} size="sm" variant="secondary" aria-label={label} aria-expanded={open}
    onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    style={{ flexShrink: 0, padding: "0 var(--cs-space-2)", gap: "var(--cs-space-1)", fontSize: 'var(--cs-size-ui-sm)',
      background: open || hover ? 'var(--cs-overlay-hover)' : 'var(--cs-white)' }}>
    <span className="cs-composer-compact-icon" aria-hidden="true">{compactIcon}</span>
    <span className="cs-composer-trigger-label">{children}</span>
    <Icon name="chevronDown" size={12} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
  </Button>;
}

export function Composer({
  placeholder, spaceBound = false, placement = 'conversation',
  value = '', contextTags = [], modelName = 'DeepSeek V4 Flash', providerName = 'DeepSeek',
  reasoningEffort = '自动', onReasoningEffortChange, onSelectModel,
  modelSupported = true, effortSupported = true,
  permissionMode, onPermissionModeChange,
  mentionItems = COMPOSER_EXAMPLES, defaultPickerOpen = false, selectedMentions, onMentionsChange, recipient: controlledRecipient, onRecipientChange,
  phase = 'idle', onStop, onQueue, sendAllowed, inputDisabled = false,
  beforeInput, editor, afterInput, onAttach, onVoice, voicePanel, voiceActive = false,
  spaceOptions = SPACE_EXAMPLES, spaceId, onSpaceChange, defaultSpaceOpen = false,
  width, onChange, onSend, editorSelection, style
}) {
  const [spaceOpen,setSpaceOpen] = React.useState(defaultSpaceOpen);
  const [spaceQuery,setSpaceQuery] = React.useState('');
  const [localSpaceId,setLocalSpaceId] = React.useState(undefined);
  const spaceAnchorRef = React.useRef(null);
  const initialSpace = spaceOptions.find(item => contextTags.some(t => t.label === item.name));
  const selectedSpaceId = spaceId ?? localSpaceId ?? (initialSpace?.id || (spaceBound ? spaceOptions[0]?.id : '') || '');
  const selectedSpace = spaceOptions.find(item => item.id === selectedSpaceId);
  const boundToSpace = Boolean(selectedSpace);
  const spaceName = selectedSpace?.name || '默认工作区';
  const visibleSpaces = [{id:'',name:'默认工作区'},...spaceOptions].filter(item => item.name.includes(spaceQuery.trim()));
  const chooseSpace = item => {
    setLocalSpaceId(item.id); onSpaceChange?.(item.id); setSpaceOpen(false);
    spaceAnchorRef.current?.querySelector('button')?.focus();
  };
  const [pickerOpen, setPickerOpen] = React.useState(defaultPickerOpen && !defaultSpaceOpen);
  const [query, setQuery] = React.useState('');
  const automation = placement === 'automation';
  const [localMentions, setLocalMentions] = React.useState([]);
  const mentions = selectedMentions ?? localMentions;
  const updateMentions = items => { setLocalMentions(items); onMentionsChange?.(items); };
  const [legacyPicked, setPicked] = React.useState([]);
  const picked = automation ? mentions.filter(item=>item.kind!=='agent') : legacyPicked;
  const [localRecipient, setRecipient] = React.useState(null);
  const recipient = controlledRecipient !== undefined ? controlledRecipient : localRecipient;
  const mentionAnchorRef = React.useRef(null);
  const editorRef = React.useRef(null);
  React.useEffect(()=>{
    if(!editorSelection || !editorRef.current)return;
    editorRef.current.focus();editorRef.current.setSelectionRange(editorSelection.start,editorSelection.end);
  },[editorSelection?.start,editorSelection?.end,editorSelection?.revision]);
  const voiceAnchorRef = React.useRef(null);
  const mentionRange = React.useRef(null);
  const openPicker = () => {
    mentionRange.current = null; setQuery(''); setPickerOpen(open => !open); setPermissionOpen(false); setConfigOpen(false); setSpaceOpen(false);
  };
  const selectMention = item => {
    if (automation) {
      updateMentions(item.kind==='agent' ? [...mentions.filter(s=>s.kind!=='agent'),item] : mentions.some(s=>s.kind===item.kind&&s.id===item.id) ? mentions : [...mentions,item]);
      const range=mentionRange.current;
      if(range)onChange?.(value.slice(0,range.start)+value.slice(range.end));
      mentionRange.current=null;setPickerOpen(false);editorRef.current?.focus();return;
    }
    if (item.kind === 'agent') {setRecipient(item);onRecipientChange?.(item);}
    else if (item.kind !== 'skill') setPicked(items => items.some(s => s.kind === item.kind && s.id === item.id) ? items : [...items, item]);
    const range = mentionRange.current;
    if (item.kind === 'skill') {
      // Readable preview only; production retains its existing inline token editor.
      const start = range?.start ?? editorRef.current?.selectionStart ?? value.length;
      const end = range?.end ?? editorRef.current?.selectionEnd ?? start;
      onChange?.(value.slice(0, start) + '@' + item.name + ' ' + value.slice(end));
    } else if (range) onChange?.(value.slice(0, range.start) + value.slice(range.end));
    mentionRange.current = null;
    setPickerOpen(false); editorRef.current?.focus();
  };
  const changeText = e => {
    const text = e.target.value;
    onChange?.(text);
    if (e.nativeEvent.isComposing) return;
    const end = e.target.selectionStart;
    const match = text.slice(0, end).match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      mentionRange.current = { start: end - match[1].length - 1, end };
      setQuery(match[1]); setPickerOpen(true); setPermissionOpen(false); setConfigOpen(false); setSpaceOpen(false);
    }
  };
  const [localPermission, setLocalPermission] = React.useState('请求批准');
  const permission = permissionMode ?? localPermission;
  const [permissionOpen, setPermissionOpen] = React.useState(false);
  const permissionRef = React.useRef(null);
  const [configOpen, setConfigOpen] = React.useState(false);
  const configRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const inputPlaceholder = placeholder || ('描述一项工作，或粘贴一份材料。输入 @ 选择' +
    (boundToSpace ? '智能体、技能、产物与资产。' : '智能体与技能。'));
  const editorMinHeight = placement === 'home' ? 80 : 64;
  const editorMaxHeight = placement === 'home' ? 260 : 200;
  React.useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(editorMaxHeight, Math.max(editorMinHeight, el.scrollHeight)) + 'px';
  }, [value, editorMinHeight, editorMaxHeight]);
  const has = sendAllowed ?? value.trim().length > 0;
  const busy = phase === 'running';
  const waiting = phase === 'stopping' || phase === 'submitting';
  const submit = () => { if (!has || inputDisabled || waiting) return; onSend?.(); setPicked([]); };
  const inputKey = e => {
    if (automation || e.isComposing || e.keyCode === 229 || e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    if (!has || inputDisabled || waiting) return;
    if (busy) onQueue?.(); else submit();
  };
  return (
    <div className="cs-composer" style={{
      position: 'relative', width: width ?? '100%',  boxSizing: 'border-box', background: 'var(--cs-white)',
      border: '1px solid rgba(23,24,28,.1)', borderRadius: 'var(--cs-radius-window)',
      boxShadow: 'var(--cs-shadow-md)', padding: "var(--cs-space-4) var(--cs-space-4) var(--cs-space-2)", ...style, minWidth: 'min(100%, var(--cs-composer-width-min))', maxWidth: 'var(--cs-composer-width-max)'
    }}>
      {beforeInput}
      {picked.length > 0 && <div aria-label={automation ? "已选任务引用" : "已选产物与资产引用"} style={{ display: 'flex', flexWrap: 'wrap', gap: "var(--cs-space-1)", marginBottom: "var(--cs-space-2)" }}>
        {picked.map(item => <span key={item.kind + item.id} style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%',
          gap: "var(--cs-space-1)", padding: "var(--cs-space-1) var(--cs-space-1) var(--cs-space-1) var(--cs-space-2)", background: 'var(--cs-accent-tint)', borderRadius: 'var(--cs-radius-sm)' }}>
          <span style={{ color: 'var(--cs-text-muted)', fontSize: 'var(--cs-size-caption)', flexShrink: 0 }}>{MENTION_LABELS[item.kind]}</span>
          <span title={item.name} style={{ fontSize: 'var(--cs-size-ui-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
          <IconButton size="sm" variant="quiet" aria-label={'移除' + item.name}
            onClick={() => automation ? updateMentions(mentions.filter(s=>s.kind!==item.kind||s.id!==item.id)) : setPicked(items => items.filter(s => s.kind !== item.kind || s.id !== item.id))}><Icon name="close" size={12} /></IconButton>
        </span>)}
      </div>}
      {editor || <textarea aria-label="任务内容" disabled={inputDisabled} onKeyDown={inputKey} ref={editorRef} value={value} placeholder={inputPlaceholder} onChange={changeText} onCompositionEnd={changeText}
        style={{
          display: 'block', width: '100%', boxSizing: 'border-box', border: 0, resize: 'none',
          background: 'transparent', font: '400 var(--cs-size-title)/1.6 var(--cs-font-sans)', color: 'var(--cs-ink)', minHeight: editorMinHeight, maxHeight: editorMaxHeight, overflowY: 'auto'
        }} />}
      {afterInput}
      <div className="cs-composer-toolbar" style={{ display: 'flex', alignItems: 'center', gap: "var(--cs-space-2)", paddingTop: "var(--cs-space-2)" }}>
        <IconButton title="添加附件" onClick={onAttach} variant="quiet" size="sm"><Icon name="plus" size={15} /></IconButton>
        <span style={{ width: 1, height: 16, background: 'rgba(23,24,28,.1)' }} />
        <div ref={mentionAnchorRef} style={{ position: 'relative', flexShrink: 0 }}>
          <ComposerTrigger open={pickerOpen} onClick={openPicker} label="选择智能体、技能与引用" compactIcon={<span>@</span>}>
            {automation ? '@ ' + (mentions.find(item=>item.kind==='agent')?.name || 'cogseed') : recipient ? '@ ' + recipient.name : contextTags.find(t => t.label.startsWith('@'))?.label || '@ 智能体'}
          </ComposerTrigger>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen} anchorRef={mentionAnchorRef} returnFocusRef={editorRef}
            label="选择智能体、技能与引用" width={360} footer="仅搜索有权限的内容">
            <ComposerMentionPicker kinds={automation ? ['agent','skill','connector','library'] : undefined} spaceBound={boundToSpace} items={mentionItems === COMPOSER_EXAMPLES ? mentionItems.map(item => item.kind === 'artifact' ? {...item, description: spaceName + ' · 任务产物'} : item) : mentionItems}
              query={query} onQuery={setQuery} onSelect={selectMention} />
          </Popover>
        </div>
        {!automation&&<div ref={spaceAnchorRef} style={{position:'relative',flexShrink:0}}>
          <ComposerTrigger label={'工作空间：' + spaceName} compactIcon={<Icon name="space" size={14}/>} open={spaceOpen}
            onClick={() => { setSpaceOpen(open=>!open); setSpaceQuery(''); setPickerOpen(false); setPermissionOpen(false); setConfigOpen(false); }}>
            <Icon name="space" size={14}/><span className="cs-composer-context-label">{spaceName}</span>
          </ComposerTrigger>
          <Popover open={spaceOpen} onOpenChange={setSpaceOpen} anchorRef={spaceAnchorRef} label="选择工作空间" width={280}
            footer="选择默认工作区后，@ 仅显示智能体与技能。">
            <Input size="md" icon="search" autoFocus aria-label="搜索工作空间" placeholder="搜索工作空间" value={spaceQuery} onChange={e=>setSpaceQuery(e.target.value)}/>
            <div style={{maxHeight:160,overflowY:'auto',paddingTop:"var(--cs-space-1)"}}>
              {visibleSpaces.map(item=><PopoverItem key={item.id} icon="space" label={item.name} selected={item.id===selectedSpaceId} onClick={()=>chooseSpace(item)}/>)}
              {!visibleSpaces.length && <div role="status" style={{padding:"var(--cs-space-4) var(--cs-space-2)",color:'var(--cs-text-muted)'}}>没有匹配的工作空间，换个关键词试试。</div>}
            </div>
          </Popover>
        </div>}
        {!automation && placement !== 'home' && <div ref={permissionRef} style={{ position: 'relative', flexShrink: 0 }}>
          <ComposerTrigger compactIcon={<Icon name="lock" size={14} />} label={'访问权限：' + permission} open={permissionOpen}
            onClick={() => { setPermissionOpen(open => !open); setConfigOpen(false); setPickerOpen(false); setSpaceOpen(false); }}>
            <Icon name="lock" size={14} />{permission}
          </ComposerTrigger>
          <Popover open={permissionOpen} onOpenChange={setPermissionOpen} anchorRef={permissionRef} label="访问权限" width={180}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: "var(--cs-space-1)" }}>
                {PERMISSIONS.map(mode => <PopoverItem key={mode} label={mode} selected={permission === mode}
                  onClick={() => {
                    setLocalPermission(mode); onPermissionModeChange?.(mode); setPermissionOpen(false);
                    permissionRef.current?.querySelector('button')?.focus();
                  }} />)}
              </div>
            </Popover>
        </div>}
        {!automation&&<>
        <span style={{ flex: 1 }} />
        <div ref={configRef} style={{ position: 'relative', flexShrink: 0 }}>
          <span ref={triggerRef} style={{ display: 'inline-flex' }}>
            <ComposerTrigger compactIcon={<Icon name="settings" size={14} />} label={'执行配置（本次任务）：' + modelName + ' · ' + reasoningEffort} open={configOpen}
              onClick={() => { setConfigOpen(open => !open); setPermissionOpen(false); setPickerOpen(false); setSpaceOpen(false); }}>
              {modelName}
              <span style={{ padding: "var(--cs-space-1) var(--cs-space-1)", borderRadius: 'var(--cs-radius-xs)',
                background: 'var(--cs-overlay-fill)', color: 'var(--cs-text-muted)' }}>{reasoningEffort}</span>
            </ComposerTrigger>
          </span>
          <Popover open={configOpen} onOpenChange={setConfigOpen} anchorRef={configRef} returnFocusRef={triggerRef}
              align="end" title="执行配置（本次任务）" width={300}>
              <div style={{ marginBottom: "var(--cs-space-1)", color: 'var(--cs-text-muted)' }}>模型</div>
              <PopoverItem label={modelName} description={providerName} onClick={modelSupported ? onSelectModel : undefined}
                trailing={<><span style={{ fontSize: 'var(--cs-size-caption)', color: 'var(--cs-text-muted)' }}>当前</span>
                  {modelSupported && onSelectModel && <Icon name="chevronRight" size={14} />}</>} />
              {!modelSupported && <p className="cs-state-rule">模型由当前智能体管理。</p>}
              <div style={{ margin: "var(--cs-space-3) 0 var(--cs-space-1)", color: 'var(--cs-text-muted)' }}>推理强度</div>
              <div role="group" aria-label="推理强度" style={{ display: 'flex', gap: "var(--cs-space-1)" }}>
                {EFFORTS.map(effort => <Button key={effort} size="sm"
                  variant={reasoningEffort === effort ? 'primary' : 'secondary'}
                  disabled={!effortSupported} aria-pressed={reasoningEffort === effort}
                  onClick={() => { if (effortSupported) onReasoningEffortChange?.(effort); }}
                  style={{ flex: 1, padding: "0 var(--cs-space-2)" }}>{effort}</Button>)}
              </div>
              {!effortSupported && <p className="cs-state-rule">当前智能体不支持调整推理强度。</p>}
          </Popover>
        </div>
        <div ref={voiceAnchorRef} style={{position:'relative',flexShrink:0}}>
          <IconButton title={voiceActive ? '结束语音输入' : '语音输入'} aria-pressed={voiceActive} onClick={onVoice} active={voiceActive} variant="quiet" size="sm"><Icon name={voiceActive ? 'stop' : 'mic'} size={15}/></IconButton>
          <Popover open={Boolean(voicePanel)} dismissible={false} anchorRef={voiceAnchorRef} align="end" label="语音输入状态" width={280}>{voicePanel}</Popover>
        </div>
        <IconButton title={busy ? '停止回复' : waiting ? (phase === 'stopping' ? '正在停止' : '正在提交') : '发送消息'}
          variant={busy || has ? 'accent' : 'quiet'} disabled={inputDisabled || waiting} onClick={busy ? onStop : submit}>
          {waiting ? <Spinner/> : <Icon name={busy ? 'stop' : 'send'} size={15} />}
        </IconButton>
        </>}
      </div>
    </div>
  );
}

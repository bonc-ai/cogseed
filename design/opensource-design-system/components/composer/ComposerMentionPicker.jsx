import React from 'react';
import { PopoverItem } from '../feedback/Popover.jsx';
import { Input } from '../forms/Input.jsx';
import { Tabs } from '../navigation/Tabs.jsx';

// Local design-preview fixtures only; production hosts supply their own scoped data.
export const COMPOSER_EXAMPLES = [
  { id: 'agent-manager', kind: 'agent', name: '项目助理', description: '整理客户材料、核对项目信息' },
  { id: 'agent-risk', kind: 'agent', name: '风险审查员', description: '检查风险事项与审查口径' },
  { id: 'skill-check', kind: 'skill', name: '项目材料核对', description: '按清单核对材料完整性' },
  { id: 'skill-minutes', kind: 'skill', name: '客户走访纪要', description: '将走访记录整理为结构化纪要' },
  { id: 'artifact-list', kind: 'artifact', name: '项目到期清单_2026Q3.xlsx', description: '华东团队空间 · 任务产物' },
  { id: 'artifact-review', kind: 'artifact', name: '交付后监测复核报告.docx', description: '华东团队空间 · 任务产物' },
  { id: 'asset-rules', kind: 'asset', name: '项目项目审查口径', description: '已沉淀资产 · 审查参考' },
  { id: 'asset-template', kind: 'asset', name: '客户走访纪要模板', description: '已沉淀资产 · 文档模板' }
];
export const MENTION_LABELS = { agent: '智能体', skill: '技能', artifact: '产物', asset: '资产', connector: '连接器', library: '资料库文件' };

export function ComposerMentionPicker({ spaceBound, items, query, onQuery, onSelect, kinds: allowedKinds }) {
  const searchRoot=React.useRef(null);
  React.useEffect(()=>{const frame=requestAnimationFrame(()=>searchRoot.current?.querySelector('input')?.focus());return ()=>cancelAnimationFrame(frame);},[]);
  const [tab, setTab] = React.useState(0);
  const kinds = allowedKinds || (spaceBound ? ['agent', 'skill', 'artifact', 'asset'] : ['agent', 'skill']);
  const kind = kinds[tab] || 'agent';
  const normalized = query.trim().toLocaleLowerCase();
  const rows = items.filter(item => item.kind === kind &&
    `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(normalized));
  return <>
    <Tabs items={kinds.map(k => MENTION_LABELS[k])} value={kinds.indexOf(kind)}
      onChange={setTab} style={{ marginBottom: "var(--cs-space-2)", gap: "var(--cs-space-4)" }} />
    <div ref={searchRoot}><Input size="md" icon="search" autoFocus aria-label={'搜索' + MENTION_LABELS[kind]}
      placeholder={'搜索' + MENTION_LABELS[kind]} value={query} onChange={e => onQuery(e.target.value)} /></div>
    <div style={{ maxHeight: 160, overflowY: 'auto', paddingTop: "var(--cs-space-1)" }}>
      {rows.length ? rows.map(item => <PopoverItem key={item.id} label={item.name} description={item.description}
        icon={kind === 'agent' ? 'shield' : kind === 'skill' ? 'automation' : 'fileText'} onClick={() => onSelect(item)} />) : <div role="status" style={{ padding: "var(--cs-space-4) var(--cs-space-2)", textAlign: 'center', color: 'var(--cs-text-muted)' }}>
        <div>{normalized ? '没有匹配的' : '暂无可选'}{MENTION_LABELS[kind]}</div>
        <div style={{ marginTop: "var(--cs-space-1)", fontSize: 'var(--cs-size-caption)' }}>{normalized ? '换个关键词，或切换分类查找。' : '可切换分类查找其他内容。'}</div>
      </div>}
    </div>
  </>;
}

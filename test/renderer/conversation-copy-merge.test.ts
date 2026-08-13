import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const utilsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/utils.js'),
  'utf8',
);
const artifactSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/chat-artifact.js'),
  'utf8',
);

function extractFunction(name: string, functionSource = source): string {
  const marker = `function ${name}`;
  let start = functionSource.indexOf(marker);
  if (start < 0) throw new Error(`missing function: ${name}`);
  if (functionSource.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const paramsStart = functionSource.indexOf('(', start);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = paramsStart; i < functionSource.length; i += 1) {
    if (functionSource[i] === '(') parenDepth += 1;
    else if (functionSource[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = functionSource.indexOf('{', i);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`missing body: ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < functionSource.length; i += 1) {
    if (functionSource[i] === '{') depth += 1;
    else if (functionSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return functionSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

function loadHelpers(): any {
  const names = [
    '_conversationActionItems',
    '_renderConversationMergeActionBar',
    '_ensureConversationMergeActionBar',
    '_copyNoticeBodyHtml',
    '_mergeSummarySectionLabel',
    '_renderMergeSummaryDetails',
    '_renderConversationResultCardHtml',
  ];
  const sandbox = {
    conversations: [{ conversation_id: 'c1', title: 'Source task' }],
    t(key: string, vars?: Record<string, any>) {
      const strings = {
        'chat.conv_copy_title': '复制会话',
        'chat.conv_pin_title': 'Pin',
        'chat.conv_unpin_title': 'Unpin',
        'chat.conv_rename_title': 'Rename',
        'chat.conv_del_title': 'Delete',
        'chat.merge.selected_count': `已选择 ${vars?.count || 0} 个会话`,
        'chat.merge.action': '合并为新会话',
        'chat.merge.summary_title': `已合并 ${vars?.count || 0} 个会话`,
        'chat.merge.summary_subtitle': `${vars?.agentCount || 0} 个 Agent 的私有上下文已归并`,
        'chat.merge.expand': '查看合并摘要',
        'chat.merge.collapse': '收起合并摘要',
        'chat.merge.section.source_conversations': 'Source Conversations',
        'chat.merge.section.context_scope': 'Context Scope',
        'chat.merge.section.confirmed_decisions': 'Confirmed Decisions',
        'chat.merge.section.current_state': 'Current State',
        'chat.merge.section.agent_private_context': 'Agent Private Context Index',
        'chat.merge.section.source_references': 'Source References',
        'chat.merge.section.open_questions': 'Open Questions',
        'chat.merge.section.conflicts_risks': 'Conflicts / Risks',
        'chat.merge.scope_selected': 'Explicitly selected tasks only',
        'chat.merge.scope_selected_result': `Selected ${vars?.count || 0} · ${vars?.range || ''}`,
        'chat.merge.scope_actual_result': `Injected ${vars?.count || 0} · ${vars?.range || ''}`,
        'chat.merge.scope_none': 'No matching messages',
      };
      return strings[key] || key;
    },
    escapeHtml: (value: unknown) => String(value),
    _renderMessageMarkdown: (value: unknown) => String(value),
    _toggleConversationPinned() {},
    _startConversationHeaderRename() {},
    _renameConversation() {},
    _deleteConversationWithConfirm() {},
    _cloneConversationWithConfirm() {},
    document: { createElement() { return {}; }, getElementById() { return null; } },
  };
  vm.runInNewContext(`${extractFunction('formatTime', utilsSource)}\n${names.map((name) => extractFunction(name)).join('\n')}\nthis.helpers = { ${names.join(',')} };`, sandbox);
  return sandbox.helpers;
}

describe('conversation copy and merge renderer', () => {
  it('adds the copy action to the single-conversation menu', () => {
    const { _conversationActionItems } = loadHelpers();
    const labels = _conversationActionItems('c1').map((item: any) => item.label);
    expect(labels).toContain('复制会话');
  });

  it('renders the merge action bar for selected conversations', () => {
    const { _renderConversationMergeActionBar } = loadHelpers();
    const html = _renderConversationMergeActionBar(2);
    expect(html).toContain('已选择 2 个会话');
    expect(html).toContain('合并为新会话');
  });

  it('renders the merged summary card title and detail sections', () => {
    const { _renderConversationResultCardHtml } = loadHelpers();
    const html = _renderConversationResultCardHtml({
      kind: 'merge',
      sourceCount: 2,
      agentCount: 1,
      summary: '## Source Conversations\n- Source task\n\n## Confirmed Decisions\n- Keep the API',
    });
    expect(html).toContain('已合并 2 个会话');
    expect(html).toContain('Source Conversations');
    expect(html).toContain('Confirmed Decisions');
    expect(html).toContain('Source task');
  });

  it('exits merge selection mode after a successful merge render', async () => {
    const sandbox: any = {
      _conversationMergeSelectionActive: true,
      _conversationMergeSelection: new Set(['c1', 'c2']),
      renderStates: [],
      t(key: string) { return key; },
      _conversationById(cid: string) { return { conversation_id: cid, title: cid, project_id: null }; },
      async _conversationOperationDialog(opts: any) { return opts.onConfirm('Merged task'); },
      async apiFetch(_url: string, opts: any) {
        const payload = JSON.parse(opts.body);
        if (payload.project_id !== null) throw new Error('expected explicit global project');
        return {
          async json() {
            return {
              conversation: { conversation_id: 'merged', title: 'Merged task' },
              summary: '## Source Conversations\n- c1\n- c2',
              agent_summaries: { agentA: {}, agentB: {} },
            };
          },
        };
      },
      _addConversationToCache() { sandbox.renderConversationList(); },
      _rememberConversationResultCard() {},
      uiToast() {},
      setView() {},
      renderConversationList() {
        sandbox.renderStates.push({
          active: sandbox._conversationMergeSelectionActive,
          count: sandbox._conversationMergeSelection.size,
        });
      },
    };
    vm.runInNewContext(`${extractFunction('_mergeSelectedConversationsWithConfirm')}\nthis.runMerge = _mergeSelectedConversationsWithConfirm;`, sandbox);

    await sandbox.runMerge();

    expect(sandbox.renderStates.at(-1)).toEqual({ active: false, count: 0 });
  });


  it('mounts cloned artifacts from their source conversation id', () => {
    expect(artifactSource).toMatch(/cid:\s*a\.source_cid\s*\|\|\s*cid/);
  });

});

# 协作概览抽屉实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 在现有右侧 `Conversation Info` 抽屉中落地一个 `Collaboration` 概览视图，用结构化方式展示当前会话的任务概览、Agent 活动与待处理事项，同时保持主会话为唯一事实源和审批执行面。

**Architecture:** 继续复用现有右侧抽屉，不新增独立页面。将已经完成的 `Agent Activity` 逻辑下沉为 `Collaboration` 抽屉里的一个 section，上方增加任务概览，下方增加待处理事项，所有数据都从现有 runtime、collaboration snapshot、history、wake、KSTAR、patch candidate 组合而来。

**Tech Stack:** Renderer 经典 JavaScript、现有 Electron IPC shim、已有 `groupChat.runtimeStatus` / collaboration snapshot / P3394 IPC 路由、Vitest renderer/main tests、现有 locale JSON 文件、无新增依赖。

---

## 文件结构

- Modify `src/renderer/index.html`: 在右侧抽屉中新增或替换为 `Collaboration` tab。
- Modify `src/renderer/modules/conversation-info.js`: 增加协作概览数据加载、任务概览渲染、待处理事项渲染，并把现有 Agent Activity 渲染嵌入为一个 section。
- Modify `src/renderer/modules/conversation.js`: 让 header 上的状态入口跳到 `Collaboration` tab，而不是单独的 `Agent Activity` tab。
- Modify `src/renderer/style.css`: 增加协作概览抽屉的 section 样式、状态卡、attention 列表、轻量跳转按钮样式。
- Modify `src/renderer/locales/en.json`, `src/renderer/locales/zh.json`, `src/renderer/locales/ja.json`, `src/renderer/locales/pt.json`: 增加 `Collaboration` 与各 section 文案。
- Modify `test/renderer/conversation-info.test.ts`: 覆盖 collaboration tab、任务概览、Agent Activity section、待处理事项 section。
- Modify `test/renderer/conversation-agent-status.test.ts`: 更新 header 状态按钮跳转目标。
- Create `test/renderer/collaboration-overview-drawer.test.ts`: 聚焦任务概览 / attention section / 主会话定位语义。
- Modify `test/renderer/conversation-info.test.ts` 中的 `renderFilesResult` helper：支持 `collaboration`、`wakeRequests`、`kstarRuns`、`patchCandidates` fixture 字段，并为 `/runtime`、`/members`、相关 overview 数据提供假数据。

## Task 1: 锁定入口决策并替换旧协作入口

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: 写红灯测试，要求抽屉里存在 Collaboration tab 且不再保留独立 Agent Activity tab**

在 `test/renderer/conversation-info.test.ts` 新增：

```ts
it('renders a Collaboration tab in the conversation info drawer', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

  expect(html).toContain('data-info-tab="collaboration"');
  expect(html).toContain('conversation_info.tab_collaboration');
  expect(html).toContain('conversation-info-tab-count-collaboration');
  expect(html).not.toContain('data-info-tab="agent-activity"');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Collaboration tab"
```

Expected: FAIL，因为目前抽屉里还没有 collaboration tab，而且仍然保留了旧的 `agent-activity` 入口。

- [ ] **Step 3: 在右侧抽屉里增加 Collaboration tab**

在 `src/renderer/index.html` 的 `.conversation-info-tabs` 中**直接用 `collaboration` 替换旧的 `agent-activity` tab**，不要并存两个入口：

```html
<button type="button" class="conversation-info-tab" data-info-tab="collaboration">
  <span data-ui-icon="layout-dashboard" data-ui-icon-class="conversation-info-tab-icon"></span>
  <span class="conversation-info-tab-label" data-i18n="conversation_info.tab_collaboration">Collaboration</span>
  <span class="conversation-info-tab-count" id="conversation-info-tab-count-collaboration"></span>
</button>
```

执行规则在这里锁死：

- 删除旧的独立 `agent-activity` tab
- 让 `Agent Activity` 只以 `Collaboration` 内嵌 section 形式存在
- 不允许两个平行入口同时存在

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Collaboration tab"
```

Expected: PASS。

## Task 2: 增加 Collaboration locale 文案

**Files:**
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Create: `test/renderer/collaboration-overview-drawer.test.ts`

- [ ] **Step 1: 写红灯测试，要求 collaboration 核心文案存在**

创建 `test/renderer/collaboration-overview-drawer.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadLocale(name: string) {
  return JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${name}.json`), 'utf8'));
}

describe('collaboration overview locales', () => {
  it('defines collaboration drawer labels in all renderer locales', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = loadLocale(locale);
      expect(data['conversation_info.tab_collaboration']).toBeTruthy();
      expect(data['conversation_info.collaboration.title']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_task_overview']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_agent_activity']).toBeTruthy();
      expect(data['conversation_info.collaboration.section_attention']).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/collaboration-overview-drawer.test.ts -t "collaboration drawer labels"
```

Expected: FAIL，因为 locale key 还不存在。

- [ ] **Step 3: 添加四套 locale 文案**

在 `en.json` 增加：

```json
{
  "conversation_info.tab_collaboration": "Collaboration",
  "conversation_info.collaboration.title": "Collaboration",
  "conversation_info.collaboration.subtitle": "How this conversation is progressing",
  "conversation_info.collaboration.loading": "Loading collaboration overview…",
  "conversation_info.collaboration.empty": "No active collaboration yet.",
  "conversation_info.collaboration.load_failed": "Could not load collaboration overview",
  "conversation_info.collaboration.section_task_overview": "Task Overview",
  "conversation_info.collaboration.section_agent_activity": "Agent Activity",
  "conversation_info.collaboration.section_attention": "Attention Needed",
  "conversation_info.collaboration.status.running": "Running",
  "conversation_info.collaboration.status.blocked": "Blocked",
  "conversation_info.collaboration.status.failed": "Failed",
  "conversation_info.collaboration.status.completed": "Completed",
  "conversation_info.collaboration.attention_none": "Nothing needs attention right now.",
  "conversation_info.collaboration.open_in_chat": "Open in chat"
}
```

并给 `zh.json` / `ja.json` / `pt.json` 加对应翻译。

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/collaboration-overview-drawer.test.ts -t "collaboration drawer labels"
```

Expected: PASS。

## Task 3: 在 conversation-info.js 里接入 Collaboration 基础态

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: 写红灯测试，要求 collaboration tab 能渲染空态**

先扩展 `renderFilesResult` helper，让它接受 `collaboration`、`wakeRequests`、`kstarRuns`、`patchCandidates` 并把它们暴露给模拟数据源。然后在 `test/renderer/conversation-info.test.ts` 新增真正的渲染测试：

```ts
it('renders the Collaboration empty state in the drawer body', async () => {
  const result = await renderFilesResult({
    activeTab: 'collaboration',
    history: [],
    files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
    actors: [],
    runtime: { processing: false },
    collaboration: null,
    wakeRequests: [],
    kstarRuns: [],
    patchCandidates: [],
  });

  expect(result.html).toContain('No active collaboration yet.');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Collaboration empty state"
```

Expected: FAIL。

- [ ] **Step 3: 增加 collaboration 分支和基础 body 渲染**

在 `src/renderer/modules/conversation-info.js` 中加入：

```js
function _renderCollaborationOverview() {
  return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.collaboration.empty', 'No active collaboration yet.'))}</div>`;
}
```

并在 `_renderBody()` 中增加分支：

```js
if (_activeTab === 'attachments') body.innerHTML = _renderAttachments();
else if (_activeTab === 'agent-activity') body.innerHTML = _renderAgentActivity();
else if (_activeTab === 'collaboration') body.innerHTML = _renderCollaborationOverview();
else body.innerHTML = _renderFiles();
```

同时在 `_refreshTabCounts()` 中增加 collaboration count 槽位。第一版规则写死为：

- 有 collaboration snapshot -> 显示 `1`
- 没有 snapshot -> 空字符串

并加一个按 section 降级的总入口：

```js
function _safeSection(renderFn, fallbackHtml) {
  try { return renderFn(); }
  catch (err) {
    _infoLog.warn('collaboration section render failed', { error: err && err.message });
    return fallbackHtml;
  }
}
```

后续 `Task Overview` / `Agent Activity` / `Attention Needed` 三个 section 都必须通过 `_safeSection(...)` 渲染，保证设计规范里的“分区降级”被真实落地。

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Collaboration empty state"
```

Expected: PASS。

## Task 4: 渲染任务概览（Task Overview）

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: 写红灯测试，要求显示目标 / 阶段 / 协作状态**

在 `test/renderer/conversation-info.test.ts` 新增一个 collaboration 渲染测试，给 snapshot 注入 `runtime.processing` 与 `collaboration` 数据：

```ts
it('renders task overview from collaboration snapshot', async () => {
  const result = await renderFilesResult({
    activeTab: 'collaboration',
    history: [],
    files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
    actors: [],
    runtime: { processing: true },
    collaboration: {
      run_id: 'wf-1',
      objective: 'Ship the release note draft',
      status: 'running',
      phase: 'drafting',
      steps: [{ title: 'Draft', status: 'running' }],
    },
  });

  expect(result.html).toContain('Ship the release note draft');
  expect(result.html).toContain('drafting');
  expect(result.html).toContain('Running');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "task overview"
```

Expected: FAIL，因为 collaboration 数据还没进入 view model。

- [ ] **Step 3: 让 snapshot 包含 collaboration 数据，并渲染任务概览**

在 `conversation-info.js` 的 `_loadAgentActivitySnapshot` 旁边增加一个新的加载器，或者在 `_load` 中并行读取 collaboration snapshot 来源。规则写死：

1. 优先使用 `runtimeStatus` 返回中的 `collaboration`
2. 如果缺失，再看当前会话历史 / process evidence 是否能补最低限度的 objective/phase
3. 绝不猜测缺失字段

实现紧凑任务概览：

```js
function _renderCollaborationTaskOverview(collaboration, runtime) {
  const status = collaboration && collaboration.status ? String(collaboration.status) : (runtime && runtime.processing ? 'running' : 'idle');
  const phase = collaboration && collaboration.phase ? String(collaboration.phase) : '';
  const objective = collaboration && collaboration.objective ? String(collaboration.objective) : _label('conversation_info.collaboration.empty', 'No active collaboration yet.');
  const stepCount = Array.isArray(collaboration && collaboration.steps) ? collaboration.steps.length : 0;
  return `<section class="conversation-info-collaboration-section conversation-info-collaboration-task-overview">
    <div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_task_overview', 'Task Overview'))}</div>
    <div class="conversation-info-collaboration-objective">${escapeHtml(objective)}</div>
    <div class="conversation-info-collaboration-meta">${escapeHtml(status)}${phase ? ` · ${escapeHtml(phase)}` : ''}${stepCount ? ` · ${stepCount} steps` : ''}</div>
  </section>`;
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "task overview"
```

Expected: PASS。

## Task 5: 将现有 Agent Activity 嵌入 Collaboration section

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: 写红灯测试，要求 collaboration 视图中包含 Agent Activity section**

```ts
it('renders Agent Activity as a section inside the collaboration drawer', async () => {
  const result = await renderFilesResult({
    activeTab: 'collaboration',
    history: [],
    files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
    actors: [{ kind: 'agent', id: 'deep', name: 'DeepResearcher' }],
    runtime: { processing: true, in_flight: ['deep'], active_turns: [{ actor: 'deep', turn_id: 'turn-1' }] },
  });

  expect(result.html).toContain('Agent Activity');
  expect(result.html).toContain('DeepResearcher');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity as a section"
```

Expected: FAIL。

- [ ] **Step 3: 将现有 `_renderAgentActivity()` 下沉为 section renderer**

把当前 Agent Activity 逻辑拆成可嵌套 section：

```js
function _renderCollaborationAgentActivitySection() {
  const rows = _deriveAgentActivityRows(_snapshot);
  const body = rows.length
    ? `<div class="conversation-info-collaboration-agent-activity-body">${_renderAgentActivitySummary(rows, _snapshot.runtime || {})}${_renderAgentActivityRows(rows)}</div>`
    : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.agent_activity.empty', 'No agents have joined this conversation yet.'))}</div>`;
  return `<section class="conversation-info-collaboration-section">
    <div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_agent_activity', 'Agent Activity'))}</div>
    ${body}
  </section>`;
}
```

然后在 `_renderCollaborationOverview()` 中调用它，而不是让 `Agent Activity` 成为单独终点。

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity as a section"
```

Expected: PASS。

## Task 6: 增加待处理事项（Attention Needed）

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-info.test.ts`
- Modify: `test/renderer/collaboration-overview-drawer.test.ts`

- [ ] **Step 1: 写红灯测试，要求待处理事项能汇总 wake/KSTAR/patch**

```ts
it('renders an attention-needed section from wake, KSTAR, and patch candidate state', async () => {
  const result = await renderFilesResult({
    activeTab: 'collaboration',
    history: [],
    files: { root: '/tmp/workspace', rootExists: true, truncated: false, count: 0, items: [] },
    actors: [],
    runtime: { processing: false },
    collaboration: { objective: 'Audit release', status: 'blocked', phase: 'review', steps: [] },
    wakeRequests: [{ id: 'wake-1', status: 'pending', agent_name: 'Researcher' }],
    kstarRuns: [{ id: 'run-1', status: 'needs_review' }],
    patchCandidates: [{ id: 'patch-1', status: 'needs_review', proposal: { title: 'Fix routing rule' } }],
  });

  expect(result.html).toContain('Attention Needed');
  expect(result.html).toContain('Researcher');
  expect(result.html).toContain('Fix routing rule');
  expect(result.html).toContain('Open in chat');
  expect(result.html).not.toMatch(/Approve|Reject|通过|拒绝/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "attention-needed"
```

Expected: FAIL。

- [ ] **Step 3: 在 collaboration 视图中渲染待处理事项 section**

先把映射规则写死，再写渲染。attention item 必须是统一结构：

```ts
type CollaborationAttentionItem = {
  kind: 'wake' | 'kstar' | 'patch' | 'failed_step';
  label: string;
  target: { type: 'message' | 'review_center'; ref: string };
};
```

映射规则：

- wake request -> `label = `${agent_name} needs wake approval``
- KSTAR run (`needs_review`) -> `label = `KSTAR review required``
- patch candidate (`needs_review`) -> `label = proposal.title || 'Patch candidate requires review'`
- failed step -> `label = `${step.title} failed``

然后在 `conversation-info.js` 中加入：

```js
function _renderCollaborationAttentionSection(items) {
  const rows = Array.isArray(items) ? items : [];
  const body = rows.length
    ? rows.map((item) => `<div class="conversation-info-collaboration-attention-item" data-attention-kind="${escapeHtml(item.kind)}" data-open-in-chat="${escapeHtml(item.target.ref)}"><div class="conversation-info-collaboration-attention-label">${escapeHtml(item.label)}</div><button type="button" class="conversation-info-collaboration-open-in-chat">${escapeHtml(_label('conversation_info.collaboration.open_in_chat', 'Open in chat'))}</button></div>`).join('')
    : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.collaboration.attention_none', 'Nothing needs attention right now.'))}</div>`;
  return `<section class="conversation-info-collaboration-section">
    <div class="conversation-info-collaboration-section-title">${escapeHtml(_label('conversation_info.collaboration.section_attention', 'Attention Needed'))}</div>
    <div class="conversation-info-collaboration-attention-list">${body}</div>
  </section>`;
}
```

必须补一个审批边界测试：

```ts
it('does not render approval action buttons inside the attention section', async () => {
  const result = await renderFilesResult(...);
  expect(result.html).not.toContain('data-kstar-review');
  expect(result.html).not.toContain('data-wake-decision');
  expect(result.html).not.toContain('data-patch-candidate-review');
});
```

第一版只允许：

- 展示 attention item
- 提供 `Open in chat`
- 跳回主会话对应位置

不允许：

- 直接在抽屉里 Approve / Reject
- 直接在抽屉里提交 review

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "attention-needed"
```

Expected: PASS。

## Task 7: 将 header 状态入口改为打开 Collaboration 抽屉

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-agent-status.test.ts`

- [ ] **Step 1: 写红灯测试，要求状态按钮跳到 collaboration**

```ts
it('routes the header agent status button into the Collaboration drawer tab', () => {
  expect(conversationSource).toContain("openAndSetTab('collaboration')");
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-agent-status.test.ts -t "Collaboration drawer tab"
```

Expected: FAIL。

- [ ] **Step 3: 将按钮跳转目标切到 Collaboration**

在 `conversation-info.js` 里新增：

```js
function openCollaboration(cid) {
  if (cid) _cid = cid;
  openAndSetTab('collaboration');
}
```

并在 `conversation.js` 中把状态按钮逻辑更新为：

```js
if (window.ConversationInfo && typeof window.ConversationInfo.openCollaboration === 'function') {
  window.ConversationInfo.openCollaboration(currentCid);
  return;
}
if (window.ConversationInfo && typeof window.ConversationInfo.openAndSetTab === 'function') {
  window.ConversationInfo.openAndSetTab('collaboration');
  return;
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-agent-status.test.ts -t "Collaboration drawer tab"
```

Expected: PASS。

## Task 8: 打磨右侧抽屉样式并完成回归验证

**Files:**
- Modify: `src/renderer/style.css`
- Test: `test/renderer/conversation-info.test.ts`, `test/renderer/conversation-agent-status.test.ts`, `test/renderer/collaboration-overview-drawer.test.ts`

- [ ] **Step 1: 先验证当前 CSS token 存在，再补 collaboration drawer 样式**

先运行：

```bash
rg -n "--border|--surface-1|--surface-2|--text|--text-muted" src/renderer/style.css
```

Expected: 所有 token 都能在现有样式中找到。如果某个 token 缺失，优先改用已存在 token，不要在这个任务里引入一套新的 token 命名。

在 `style.css` 中增加：

```css
.conversation-info-collaboration {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
}
.conversation-info-collaboration-section {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-1, #fff);
  padding: 12px;
}
.conversation-info-collaboration-section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
}
.conversation-info-collaboration-attention-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 12px;
}
.conversation-info-collaboration-open-in-chat {
  margin-top: 6px;
}
```

- [ ] **Step 2: 运行 renderer 定向测试**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts test/renderer/conversation-agent-status.test.ts test/renderer/collaboration-overview-drawer.test.ts test/renderer/ipc-shim.test.ts
```

Expected: PASS。

- [ ] **Step 3: 运行 main/runtime 相关回归**

Run:

```bash
npm run test:js -- test/main/features/group_chat/state.test.ts test/main/features/group_chat/collaboration.test.ts test/main/ipc/p3394-protocol-events.test.ts
```

Expected: PASS。

- [ ] **Step 4: 运行 typecheck 与 diff 检查（typecheck 只作为补充，不作为 renderer 正确性的主信号）**

Run:

```bash
npm run typecheck
git diff --check -- src/renderer/index.html src/renderer/modules/conversation-info.js src/renderer/modules/conversation.js src/renderer/style.css src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json test/renderer/conversation-info.test.ts test/renderer/conversation-agent-status.test.ts test/renderer/collaboration-overview-drawer.test.ts
```

Expected: `tsc --noEmit` PASS，`git diff --check` 无格式错误。

## Verification

- 右侧抽屉存在 `Collaboration` 入口。
- `Task Overview`、`Agent Activity`、`Attention Needed` 三块在同一抽屉内共存。
- `Agent Activity` 作为模块继续工作，不与新的 collaboration 抽屉冲突。
- 审批项只做展示与定位，不迁出主会话。
- 主会话仍是事实源，抽屉只是结构化投影。

## Next skill

`$superpower-subagents` 或 `$superpower-executing-plans`

// 真实 Chromium DOM 验收：首页多 Agent 选择与展示（PRD v2.4 + 优化说明 v0.17）。
//
// 覆盖第 8.5 条要求的「多来源 Agent 候选及底栏展示」DOM 自动化：
//   A. 底栏压缩阶梯 —— 真实 index.html 的输入区结构 + 生产 CSS，按容器宽度断言
//      成员名/模型名在 900/640/520px 都不被 display:none 抹掉，次要 chrome 收起。
//   B. 多来源候选三态 —— 真实 composer-members.js 渲染候选列表，断言外接 Agent
//      可勾选、空间内 Task Agent 在列、被空间排除的内部 Agent 以 aria-disabled +
//      锁图标 + 原因出现且不可被选中；底栏摘要与成员一致。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: false } });
  const root = path.resolve(__dirname, '../../../src/renderer');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body></body></html>'));
  for (const file of ['tokens.css', 'style.css', 'workspace.css', 'ui-components.css']) {
    await window.webContents.insertCSS(read(file));
  }
  for (const file of ['modules/icons.js', 'modules/ui-form.js', 'modules/composer-members.js']) {
    await window.webContents.executeJavaScript(`${read(file)}\n//# sourceURL=${file}`);
  }

  const page = {
    indexHtml: read('index.html'),
    agents: [
      { agent_id: 'cli-codex', name: 'Codex', runtime: { kind: 'cli', cli: 'codex' } },
      { agent_id: 'task-a', name: '集成验证Agent', runtime: { kind: 'in-process' } },
      { agent_id: 'task-x', name: '编写助手', runtime: { kind: 'in-process' } },
    ],
  };
  // 大段 HTML/JSON 先作为变量注入：直接嵌进模板字符串会让脚本在编译期就失败。
  await window.webContents.executeJavaScript(
    `window.__INDEX_HTML__ = ${JSON.stringify(page.indexHtml)}; window.__AGENTS__ = ${JSON.stringify(page.agents)}; true;`,
  );

  const outcome = await window.webContents.executeJavaScript(`(() => {
    try {
      const checks = [];
      const assert = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

      // ── A. 底栏压缩阶梯（真实 index.html 结构 + 生产 CSS） ────────────────
      const parsed = new DOMParser().parseFromString(window.__INDEX_HTML__, 'text/html');
      const source = parsed.querySelector('#panel-new-chat .new-chat-input-area');
      if (!source) throw new Error('index.html missing #panel-new-chat .new-chat-input-area');
      document.body.innerHTML = '';
      const area = document.importNode(source, true);
      area.style.width = '900px';
      document.body.appendChild(area);
      const bar = area.querySelector('.chat-bottom-bar');
      if (!bar) throw new Error('index.html missing .chat-bottom-bar');

      // 模型入口与工作空间 chip 由 JS 注入（index.html 里没有），按生产类名补齐。
      const modelChip = document.createElement('button');
      modelChip.type = 'button';
      modelChip.className = 'model-chip';
      modelChip.innerHTML = '<span class="model-chip-icon"></span>'
        + '<span class="model-chip-label">gpt-6-astra</span>'
        + '<span class="exec-config-effort">high</span>';
      bar.appendChild(modelChip);
      const workspaceChip = document.createElement('div');
      workspaceChip.className = 'workspace-chip';
      workspaceChip.innerHTML = '<span class="workspace-chip-prefix">@</span>'
        + '<span class="workspace-chip-label">默认工作区</span>';
      bar.appendChild(workspaceChip);

      const readBox = (selector) => {
        const el = area.querySelector(selector);
        if (!el) return null;
        const computed = getComputedStyle(el);
        return {
          display: computed.display,
          maxWidth: computed.maxWidth,
          width: Math.round(el.getBoundingClientRect().width),
          text: String(el.textContent || '').trim(),
        };
      };
      const atWidth = (px) => {
        area.style.width = px + 'px';
        void area.offsetWidth; // 强制重排：容器查询按新宽度重新求值
        return {
          name: readBox('.chat-recipient-name'),
          model: readBox('.model-chip-label'),
          workspace: readBox('.workspace-chip-label'),
        };
      };

      const wide = atWidth(900);
      assert('900px：成员名可见且是具体名字', wide.name && wide.name.display !== 'none' && wide.name.width > 0 && wide.name.text === 'Commander', wide.name);
      assert('900px：模型名可见且是具体模型', wide.model && wide.model.display !== 'none' && wide.model.width > 0 && wide.model.text === 'gpt-6-astra', wide.model);
      assert('900px：工作空间文字可见', wide.workspace && wide.workspace.display !== 'none', wide.workspace);

      const mid = atWidth(640);
      assert('640px：成员名仍可见（只截断不隐藏）', mid.name && mid.name.display !== 'none' && mid.name.width > 0 && mid.name.text === 'Commander', mid.name);
      assert('640px：模型名仍可见（只截断不隐藏）', mid.model && mid.model.display !== 'none' && mid.model.width > 0, mid.model);
      assert('640px：次要 chrome（工作空间文字）先收起', mid.workspace && mid.workspace.display === 'none', mid.workspace);
      assert('640px：成员名宽度上限收紧到 170px', mid.name && mid.name.maxWidth === '170px', mid.name && mid.name.maxWidth);

      const narrow = atWidth(520);
      assert('520px：成员名仍可见', narrow.name && narrow.name.display !== 'none' && narrow.name.width > 0, narrow.name);
      assert('520px：模型名仍可见', narrow.model && narrow.model.display !== 'none' && narrow.model.width > 0, narrow.model);
      assert('520px：成员名宽度上限收紧到 150px', narrow.name && narrow.name.maxWidth === '150px', narrow.name && narrow.name.maxWidth);
      assert('520px：模型名宽度上限收紧到 128px', narrow.model && narrow.model.maxWidth === '128px', narrow.model && narrow.model.maxWidth);

      // ── B. 多来源 Agent 候选（真实 composer-members.js 渲染） ────────────
      const agents = window.__AGENTS__;
      const store = new Map();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: (key) => (store.has(key) ? store.get(key) : null),
          setItem: (key, value) => { store.set(key, String(value)); },
          removeItem: (key) => { store.delete(key); },
        },
      });
      window.currentCid = 'conv-dom-test';
      window.getComposerAgentList = () => agents;
      window.getComposerAgentCandidates = () => [agents[0], agents[1]];
      window.getComposerOutOfScopeAgents = () => [agents[2]];
      window.getComposerMemberScopeHint = () => '';
      window.escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
      ));
      window.t = (key) => key;
      if (!window.composerMembers) throw new Error('composer-members.js did not expose window.composerMembers');

      const list = document.createElement('div');
      list.className = 'skill-picker-list';
      list.appendChild(window.composerMembers.buildPickerList('conversation', 'members', ''));
      document.body.appendChild(list);

      const codexRow = list.querySelector('[data-composer-member="cli-codex"]');
      assert('候选含外接 Agent 且可勾选', !!codexRow && !!codexRow.querySelector('.ui-checkbox'), codexRow && codexRow.className);
      const taskRow = list.querySelector('[data-composer-member="task-a"]');
      assert('候选含空间内 Task Agent', !!taskRow, taskRow && taskRow.className);
      const blocked = list.querySelector('[data-composer-member-unavailable="task-x"]');
      assert('被空间排除的 Agent 仍出现在列表（不静默消失）', !!blocked, blocked && blocked.className);
      assert('被排除行 aria-disabled', !!blocked && blocked.getAttribute('aria-disabled') === 'true', blocked && blocked.getAttribute('aria-disabled'));
      assert('被排除行有锁图标', !!blocked && !!blocked.querySelector('.composer-member-lock'), null);
      assert('被排除行说明原因', !!blocked && /不在当前空间能力范围/.test(blocked.textContent || ''), blocked && String(blocked.textContent).trim().slice(0, 80));
      assert('被排除行不可被点选（无 data-composer-member）', !!blocked && !blocked.hasAttribute('data-composer-member'), null);

      window.composerMembers.setMembers('conversation', [
        { kind: 'commander', id: 'commander', name: 'CogSeed' },
        { kind: 'agent', id: 'cli-codex', name: 'Codex' },
        { kind: 'agent', id: 'task-a', name: '集成验证Agent' },
      ]);
      const summary = window.composerMembers.memberSummary(window.composerMembers.getMembers('conversation'));
      assert('底栏摘要=首位名称 + 剩余人数', summary && summary.name === 'CogSeed' && summary.total === 3 && summary.extra === 2, summary);

      const failed = checks.filter((check) => !check.ok);
      return { passed: checks.length - failed.length, total: checks.length, failed };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), stack: String((error && error.stack) || '').slice(0, 900) };
    }
  })()`);

  if (outcome.error) {
    console.error(JSON.stringify(outcome, null, 2));
    app.exit(1);
    return;
  }
  console.log(JSON.stringify(outcome));
  app.exit(outcome.failed.length ? 1 : 0);
}).catch((error) => { console.error(error); app.exit(1); });

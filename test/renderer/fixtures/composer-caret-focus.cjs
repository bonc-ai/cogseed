// 真实 Chromium 回归：选择器勾选成员后，焦点往返不能把编辑器插入点丢到开头。
//
// 真机现象（用户反馈）：通过底部 @ 入口选 agent 后，光标自动跳到输入框最左边。
// 根因链：勾选会把焦点交给选择器搜索框（多选模式不关闭列表）→ 关闭后再还给编辑器；
// 浏览器在 focus 事件**之后**才放置默认 caret（落在开头），覆盖同步恢复，并被 focus
// 监听同步回 textarea（权威插入点被写成 0）→ api.focus() 之后读到 0，光标停在开头。
//
// 这类时序只能靠真实 Chromium 复现：fake DOM 里没有"浏览器默认 caret"这一步。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../../..');
const SOURCE = fs.readFileSync(path.join(APP, 'src/renderer/modules/conversation.js'), 'utf8');
const MEMBERS_SOURCE = fs.readFileSync(path.join(APP, 'src/renderer/modules/composer-members.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}`;
  const start = SOURCE.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return SOURCE.slice(start, i + 1); }
  }
  throw new Error(`unterminated ${name}`);
}

const FUNCTIONS = [
  '_chatRichInputId', 'getChatRichComposerEditor', 'syncChatRichComposerFromTextarea', 'focusChatRichComposer',
  '_chatRichSerializeNode', '_chatRichTextLength', '_chatRichHasAuthoredContent', '_chatRichEnsureTrailingBreak',
  '_chatRichCreateMentionChip', '_chatRichSegmentTokens', '_chatRichRenderValue', '_chatRichMentionSidecarFromDom',
  '_chatRichNextSibling', '_chatRichNormalizeMentionGaps', '_chatRichHandleEditorInput',
  '_chatRichRangeLength', '_chatRichSelectionIndexes', '_chatRichFindPosition', '_chatRichApplyBoundary', '_chatRichSetSelection',
  '_chatRichLabelParts', '_chatRichCreateUseChip', '_chatRichRestoreCaretOnFocus', '_chatRichCreateApi',
  '_chatRichInputTarget', '_chatRichAutoGrowMax', '_chatRichInsertText', '_chatRichRecipientChipId', '_initMentionMirror',
].map(extractFunction).join('\n\n');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 700, webPreferences: { sandbox: false } });
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body></body></html>'));
  for (const file of ['tokens.css', 'style.css', 'ui-components.css']) {
    await window.webContents.insertCSS(fs.readFileSync(path.join(APP, 'src/renderer', file), 'utf8'));
  }
  await window.webContents.executeJavaScript(`window.__MEMBERS_SOURCE__ = ${JSON.stringify(MEMBERS_SOURCE)}; window.__FUNCTIONS__ = ${JSON.stringify(FUNCTIONS)}; true;`);

  const outcome = await window.webContents.executeJavaScript(`(async () => {
    try {
      const checks = [];
      const assert = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      const host = document.createElement('div');
      host.className = 'new-chat-input-area';
      host.style.width = '760px';
      const textarea = document.createElement('textarea');
      textarea.id = 'chat-input';
      textarea.setAttribute('placeholder', '输入任务');
      host.appendChild(textarea);
      document.body.appendChild(host);

      const agents = [
        { agent_id: 'cli-codex', name: 'Codex', enabled: true, runtime: { kind: 'cli', cli: 'codex' } },
        { agent_id: 'task-a', name: '集成验证Agent', enabled: true, runtime: { kind: 'in-process' } },
      ];
      const store = new Map();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      });
      window.currentCid = 'conv-caret';
      window.getComposerAgentList = () => agents;
      window.getComposerAgentCandidates = () => agents;
      window.getComposerOutOfScopeAgents = () => [];
      window.getComposerMemberScopeHint = () => '';
      window.escapeHtml = (v) => String(v == null ? '' : v);
      window.t = (key) => key;
      const _chatRichComposers = new Map();
      const _chatRichUploadPasteFiles = () => false;
      function _deleteChatUseTokenAtCaret() { return false; }
      function _moveChatUseTokenCaret() { return false; }
      eval(window.__FUNCTIONS__);
      eval(window.__MEMBERS_SOURCE__);

      _initMentionMirror(textarea);
      const api = _chatRichComposers.get('chat-input');
      const members = window.composerMembers;
      if (!api) throw new Error('rich composer api missing');
      if (!members) throw new Error('composerMembers missing');

      const caret = () => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        const range = sel.getRangeAt(0);
        if (!api.editor.contains(range.startContainer)) return null;
        return _chatRichSelectionIndexes(api.editor);
      };

      // 场景 A：焦点留在选择器（搜索框抢焦点）→ 关闭弹窗还给编辑器，光标必须仍在插入点之后。
      // 归还路径与生产一致：_closeAgentPicker → focusChatRichComposer → api.focus()。
      api.editor.focus();
      textarea.selectionStart = 0; textarea.selectionEnd = 0;
      members.insertMention('conversation', { kind: 'agent', id: 'cli-codex', name: 'Codex' });
      await settle();
      const picker = document.createElement('input');
      picker.id = 'agent-picker-search';
      document.body.appendChild(picker);
      picker.focus();                                     // _bindComposerMemberRows 的 search?.focus()
      focusChatRichComposer(textarea);                    // 关闭弹窗 returnFocus
      await settle();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const afterReturn = { value: textarea.value, caret: caret(), textareaCaret: textarea.selectionStart };
      assert('插入标记后的插入点正确', afterReturn.value === '@Codex ' && afterReturn.caret && afterReturn.caret.start === 7, afterReturn);
      assert('焦点往返后光标不回左', afterReturn.caret && afterReturn.caret.start === afterReturn.value.length, afterReturn);

      // 场景 B：第二个成员插到末尾，插入点继续留在末尾。
      // 这里故意用裸 editor.focus()（没有 api.focus() 的显式恢复），验证 focus 兜底校正。
      const button = document.createElement('button');
      document.body.appendChild(button);
      button.focus();
      members.insertMention('conversation', { kind: 'agent', id: 'task-a', name: '集成验证Agent' });
      await settle();
      api.editor.focus();
      await settle();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const afterSecond = { value: textarea.value, caret: caret() };
      assert('第二个成员插入后光标在末尾', afterSecond.value === '@Codex @集成验证Agent '
        && afterSecond.caret && afterSecond.caret.start === afterSecond.value.length, afterSecond);

      // 场景 C：用户真实点击（mousedown）时不得把插入点拉回上一次记录的位置。
      const mousedown = new MouseEvent('mousedown', { bubbles: true });
      api.editor.dispatchEvent(mousedown);
      api.editor.focus();
      _chatRichSetSelection(api.editor, 0, 0);            // 浏览器按点击位置放置的插入点
      await settle();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const afterClick = { caret: caret() };
      assert('用户点击定位不被拉回（mousedown 场景）', afterClick.caret && afterClick.caret.start === 0, afterClick);
      api.editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      // 场景 D：真机时序 —— focus 事件派发时浏览器已把编辑器插入点放在开头，而 textarea
      // 记录仍是权威插入点。旧实现会在 focus 同步阶段把 0 写回 textarea（api.focus() 之后
      // 读到的就是 0，光标停在最左边）；修复后由延时校正恢复记录值。
      api.editor.focus();
      textarea.selectionStart = 7; textarea.selectionEnd = 7;
      _chatRichSetSelection(api.editor, 0, 0);
      api.editor.dispatchEvent(new FocusEvent('focus'));
      await settle();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const afterDefaultCaret = { caret: caret(), textareaCaret: textarea.selectionStart };
      assert('focus 时浏览器已放置开头 caret 也要恢复到记录插入点', afterDefaultCaret.caret && afterDefaultCaret.caret.start === 7 && afterDefaultCaret.textareaCaret === 7, afterDefaultCaret);

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

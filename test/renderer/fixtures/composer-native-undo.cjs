// MA-06 真实 Chromium 验证：富编辑器里删除点名标记 → 原生撤销恢复。
//
// 走真实编辑命令（`document.execCommand('delete' / 'undo' / 'redo')`）而不是合成
// 键盘事件：只有浏览器自身的编辑命令才会进入原生 undo 栈，这正是真机 Cmd+Z 依赖的
// 那一条路径（agents.js 的旧处理器曾用 preventDefault + 直接改 value 绕过它）。
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
  await window.webContents.executeJavaScript(
    `window.__FUNCTIONS__ = ${JSON.stringify(FUNCTIONS)}; window.__MEMBERS_SOURCE__ = ${JSON.stringify(MEMBERS_SOURCE)}; true;`,
  );

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

      const agents = [{ agent_id: 'cli-codex', name: 'Codex', enabled: true, runtime: { kind: 'cli', cli: 'codex' } }];
      const store = new Map();
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      });
      window.currentCid = 'conv-undo';
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

      // 真实用户动作：先输入普通文本，再从成员列表插入 Codex 标记。
      api.editor.focus();
      textarea.value = 'undo-check ';
      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;
      api.renderFromTextarea();
      members.insertMention('conversation', { kind: 'agent', id: 'cli-codex', name: 'Codex' });
      await settle();
      const before = { value: textarea.value, chip: !!api.editor.querySelector('.chat-rich-mention-chip') };
      assert('插入后编辑器里有标记', before.chip, before);

      // 把插入点放到标记之后，用浏览器自身的删除命令移除它（进入原生 undo 栈）。
      api.editor.focus();
      _chatRichSetSelection(api.editor, textarea.value.length);
      const deleted = document.execCommand('delete');
      await settle();
      const afterDelete = textarea.value;
      assert('删除命令移除了标记', deleted && !afterDelete.includes('@Codex'), { deleted, afterDelete });

      // 原生撤销：标记与身份必须回来。
      const undone = document.execCommand('undo');
      await settle();
      const afterUndo = { value: textarea.value, chip: !!api.editor.querySelector('.chat-rich-mention-chip') };
      assert('原生撤销恢复了标记', undone && afterUndo.chip && afterUndo.value.includes('@Codex'), afterUndo);

      // 原生重做：再次移除。
      const redone = document.execCommand('redo');
      await settle();
      const afterRedo = { value: textarea.value, chip: !!api.editor.querySelector('.chat-rich-mention-chip') };
      assert('原生重做再次移除标记', redone && !afterRedo.chip && !afterRedo.value.includes('@Codex'), afterRedo);

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

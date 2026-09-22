// 正文点名标记的 DOM 往返（conversation.js 富编辑器 × composer-members.js 身份解析）。
//
// 这是本次多 Agent 改造里最容易出错的一条缝：可见的绿色 chip 是 contenteditable
// 里的不可编辑节点，隐藏 textarea 必须始终是纯文本。用例钉住：
//   - 已注册 Agent 名渲染成绑定身份的 chip（dataset.agentId），未知/普通文本保持文本节点
//   - chip 序列化回原文（含尾随空格）→ 值无损往返，不产生幻影换行
//   - 从 DOM 删掉 chip（浏览器整块删除的实际结果）后序列化不再包含该标记
//   - 多个标记与普通文字混排时顺序与字符流都不变

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const composerMembersSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/composer-members.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const AGENTS = [
  { agent_id: 'cli-codex', name: 'Codex' },
  { agent_id: 'task-a', name: '集成验证Agent' },
];

function loadEditor(sidecar: any[] = []) {
  const fns = [
    '_chatRichSerializeNode',
    '_chatRichTextLength',
    '_chatRichHasAuthoredContent',
    '_chatRichEnsureTrailingBreak',
    '_chatRichCreateMentionChip',
    '_chatRichSegmentTokens',
    '_chatRichRenderValue',
    '_chatRichMentionSidecarFromDom',
  ].map(extractFunction).join('\n\n');

  const bootstrap = `
    const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
    class FakeNode {
      constructor(t) { this.nodeType = t; this.childNodes = []; this.parentNode = null; }
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
        return c;
      }
    }
    class FakeText extends FakeNode { constructor(v) { super(3); this.nodeValue = String(v); } }
    class FakeEl extends FakeNode {
      constructor(tag) {
        super(1);
        this.tagName = String(tag).toUpperCase();
        this.dataset = {};
        this.attributes = {};
        this.contentEditable = '';
      }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      set textContent(v) {
        this.childNodes.forEach((c) => { c.parentNode = null; });
        this.childNodes = [];
        if (v) this.appendChild(new FakeText(v));
      }
      get textContent() {
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      }
      querySelector(sel) {
        if (sel !== 'br[data-chat-bogus="1"]') return null;
        const walk = (node) => {
          for (const c of node.childNodes) {
            if (c.nodeType === 1 && c.tagName === 'BR' && c.dataset.chatBogus === '1') return c;
            const f = walk(c);
            if (f) return f;
          }
          return null;
        };
        return walk(this);
      }
    }
    const document = { createElement: (t) => new FakeEl(t), createTextNode: (v) => new FakeText(v) };
    const _findChatUseTokens = () => [];
    const composerMembers = (() => {
      const TOKEN_CHAR_RE = /[A-Za-z0-9_\\u4e00-\\u9fff-]/;
      const table = [
        { id: 'commander', name: 'CogSeed', aliases: ['commander', 'cogseed'] },
        ...${JSON.stringify(AGENTS)}.map((a) => ({ id: a.agent_id, name: a.name, aliases: [] })),
      ];
      let tokens = ${JSON.stringify(sidecar)};
      return {
        mentionTokensForTarget: (_target, text) => tokens.filter((token) => String(text).slice(token.start, token.end) === token.text),
        setMentionSidecar: (_target, next) => { tokens = next; },
        mentionSidecarSnapshot: () => tokens,
        mentionTableFrom: () => table,
      };
    })();
    const window = {
      composerMembers,
      getComposerAgentList: () => ${JSON.stringify(AGENTS)},
    };
    function makeEditor() { return new FakeEl('div'); }
  `;

  return vm.runInNewContext(`
    ${bootstrap}
    ${fns}
    ({
      render: (value) => { const e = makeEditor(); _chatRichRenderValue(e, value, 'conversation'); return e; },
      serialize: (n) => _chatRichSerializeNode(n),
      textLength: (n) => _chatRichTextLength(n),
      forgedMention: () => {
        const e = makeEditor();
        const chip = new FakeEl('span');
        chip.dataset.chatMentionChip = '1';
        chip.dataset.agentId = 'cli-codex';
        chip.dataset.agentName = 'Codex';
        chip.dataset.token = '@Codex ';
        e.appendChild(chip);
        return _chatRichMentionSidecarFromDom(e, 'conversation');
      },
      ingest: (n) => _chatRichMentionSidecarFromDom(n, 'conversation'),
    });
  `, {});
}

function loadPasteHarness() {
  const fn = extractFunction('_chatRichCreateApi');
  return vm.runInNewContext(`
    const listeners = {};
    const textarea = {
      id: 'chat-input', value: '', style: {}, dataset: {},
      addEventListener(type, cb) { (listeners['textarea:' + type] ||= []).push(cb); },
    };
    const editor = {
      style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0,
      addEventListener(type, cb) { (listeners['editor:' + type] ||= []).push(cb); },
    };
    const document = { activeElement: null };
    const window = { composerMembers: null };
    const Event = function Event() {};
    function _chatRichUploadPasteFiles() { return false; }
    function _chatRichInputTarget() { return 'conversation'; }
    function _chatRichAutoGrowMax() { return 200; }
    let inserted = [];
    function _chatRichInsertText(_editor, text) { inserted.push(text); }
    ${fn}
    _chatRichCreateApi(textarea, editor);
    ({
      paste: (event) => listeners['editor:paste'][0](event),
      inserted: () => inserted.slice(),
    });
  `, {});
}

function loadMentionUndoHarness() {
  const functions = [
    '_chatRichSerializeNode',
    '_chatRichTextLength',
    '_chatRichCreateMentionChip',
    '_chatRichSegmentTokens',
    '_chatRichRangeLength',
    '_chatRichSelectionIndexes',
    '_chatRichFindPosition',
    '_chatRichApplyBoundary',
    '_chatRichSetSelection',
    '_chatRichLabelParts',
    '_chatRichCreateUseChip',
    '_chatRichHasAuthoredContent',
    '_chatRichEnsureTrailingBreak',
    '_chatRichHandleEditorInput',
    '_chatRichRenderValue',
    '_chatRichMentionSidecarFromDom',
    '_chatRichInputTarget',
    '_chatRichAutoGrowMax',
    '_chatRichInsertText',
    '_chatRichCreateApi',
    '_initMentionMirror',
  ].map(extractFunction).join('\n\n');

  const bootstrap = `
    const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
    class FakeNode {
      constructor(type) { this.nodeType = type; this.childNodes = []; this.parentNode = null; }
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      }
      insertBefore(child, before) {
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = this.childNodes.indexOf(before);
        child.parentNode = this;
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        return child;
      }
      removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      }
      contains(candidate) {
        if (candidate === this) return true;
        return this.childNodes.some((child) => child.contains ? child.contains(candidate) : child === candidate);
      }
    }
    class FakeText extends FakeNode {
      constructor(value) { super(3); this.nodeValue = String(value); }
    }
    class FakeElement extends FakeNode {
      constructor(tag) {
        super(1);
        this.tagName = String(tag).toUpperCase();
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.listeners = {};
        this.classList = { add() {} };
        this.scrollHeight = 0;
        this.scrollTop = 0;
        this.value = '';
        this.selectionStart = 0;
        this.selectionEnd = 0;
      }
      addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
      dispatchEvent(event) {
        event.target = this;
        for (const callback of this.listeners[event.type] || []) callback(event);
        return true;
      }
      emitInput(inputType) { this.dispatchEvent({ type: 'input', inputType }); }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      getAttribute(name) { return this.attributes[name] || '';
      }
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
      focus() { document.activeElement = this; }
      append(...children) { children.forEach((child) => this.appendChild(child)); }
      querySelector(selector) {
        if (selector !== 'br[data-chat-bogus="1"]') return null;
        const visit = (node) => {
          for (const child of node.childNodes || []) {
            if (child.nodeType === 1 && child.tagName === 'BR' && child.dataset.chatBogus === '1') return child;
            const found = visit(child);
            if (found) return found;
          }
          return null;
        };
        return visit(this);
      }
      getBoundingClientRect() { return { top: 0, bottom: 100 }; }
      set textContent(value) {
        this.childNodes.forEach((child) => { child.parentNode = null; });
        this.childNodes = [];
        if (value) this.appendChild(new FakeText(value));
      }
      get textContent() {
        return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('');
      }
    }
    class Event {
      constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.inputType = init.inputType || ''; }
      preventDefault() { this.defaultPrevented = true; }
    }
    class InputEvent extends Event {}
    class CustomEvent extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } }
    const selectionRange = {
      startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
    };
    const selection = {
      rangeCount: 0,
      getRangeAt: () => selectionRange,
      removeAllRanges() { this.rangeCount = 0; },
      addRange(range) {
        this.rangeCount = 1;
        this.range = range;
      },
    };
    function cloneTree(node) {
      if (node.nodeType === Node.TEXT_NODE) return new FakeText(node.nodeValue || '');
      const clone = new FakeElement(node.tagName || 'div');
      clone.dataset = { ...(node.dataset || {}) };
      clone.attributes = { ...(node.attributes || {}) };
      clone.contentEditable = node.contentEditable;
      for (const child of node.childNodes || []) clone.appendChild(cloneTree(child));
      return clone;
    }
    class PrefixRange {
      selectNodeContents(root) { this.root = root; }
      setEnd(container, offset) { this.endContainer = container; this.endOffset = offset; }
      cloneContents() {
        const fragment = new FakeNode(Node.DOCUMENT_FRAGMENT_NODE);
        const children = this.endContainer === this.root
          ? this.root.childNodes.slice(0, this.endOffset)
          : [];
        children.forEach((child) => fragment.appendChild(cloneTree(child)));
        return fragment;
      }
      detach() {}
    }
    const document = {
      activeElement: null,
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (value) => new FakeText(value),
      createRange: () => new PrefixRange(),
      getElementById: (id) => id === 'chat-input' ? textarea : null,
    };
    const parent = new FakeElement('div');
    const textarea = new FakeElement('textarea');
    textarea.id = 'chat-input';
    textarea.value = '@Codex task';
    textarea.setAttribute('placeholder', 'Message');
    parent.appendChild(textarea);
    const localStore = new Map();
    const localStorage = {
      getItem: (key) => localStore.has(key) ? localStore.get(key) : null,
      setItem: (key, value) => localStore.set(key, String(value)),
    };
    const window = globalThis;
    window.window = window;
    window.localStorage = localStorage;
    window.currentCid = 'conv-undo';
    window.getComposerAgentList = () => ${JSON.stringify(AGENTS)};
    window.getComposerAgentCandidates = window.getComposerAgentList;
    window.refreshExecConfigChip = () => {};
    window.dispatchEvent = () => true;
    window.addEventListener = () => {};
    window.getSelection = () => selection;
    const t = (key) => key;
    const setInterval = () => 1;
    const _findChatUseTokens = () => [];
    const _chatRichComposers = new Map();
    const _chatRichRecipientChipId = () => '';
    const _chatRichUploadPasteFiles = () => false;
    let skillDeleteResult = false;
    let skillDeleteCalls = 0;
    const _deleteChatUseTokenAtCaret = () => {
      skillDeleteCalls += 1;
      return skillDeleteResult;
    };
    const _moveChatUseTokenCaret = () => false;
  `;

  return vm.runInNewContext(`${bootstrap}\n${composerMembersSource}\n${functions}\n
    window.composerMembers.setMembers('conversation', [{ kind: 'agent', id: 'cli-codex', name: 'Codex' }]);
    window.composerMembers.setMentionSidecar('conversation', [
      { id: 'cli-codex', name: 'Codex', start: 0, end: 7, text: '@Codex ' },
    ]);
    _initMentionMirror(textarea);
    const api = _chatRichComposers.get('chat-input');
    const nativeChip = api.editor.childNodes.find((node) => node.dataset?.chatMentionChip === '1');
    function setCaret(offset) {
      selectionRange.startContainer = api.editor;
      selectionRange.startOffset = offset;
      selectionRange.endContainer = api.editor;
      selectionRange.endOffset = offset;
      selection.rangeCount = 1;
    }
    function dispatchDeleteKey(key) {
      const chipIndex = api.editor.childNodes.indexOf(nativeChip);
      setCaret(key === 'Backspace' ? chipIndex + 1 : chipIndex);
      const event = new Event('keydown');
      event.key = key;
      event.isComposing = false;
      event.keyCode = 0;
      event.shiftKey = false;
      event.metaKey = false;
      event.ctrlKey = false;
      event.altKey = false;
      api.editor.dispatchEvent(event);
      if (!event.defaultPrevented && nativeChip.parentNode === api.editor) {
        const at = api.editor.childNodes.indexOf(nativeChip);
        api.editor.removeChild(nativeChip);
        setCaret(at);
        api.editor.dispatchEvent(new InputEvent('input', {
          inputType: key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
        }));
      }
      return {
        prevented: !!event.defaultPrevented,
        removedAsNode: nativeChip.parentNode === null,
        chipText: nativeChip.textContent,
      };
    }
    function historyUndo() {
      api.editor.insertBefore(nativeChip, api.editor.childNodes[0] || null);
      setCaret(1);
      api.editor.dispatchEvent(new InputEvent('input', { inputType: 'historyUndo' }));
    }
    function historyRedo() {
      const at = api.editor.childNodes.indexOf(nativeChip);
      api.editor.removeChild(nativeChip);
      setCaret(Math.max(0, at));
      api.editor.dispatchEvent(new InputEvent('input', { inputType: 'historyRedo' }));
    }
    ({
      textarea,
      editor: api.editor,
      members: window.composerMembers,
      firstChip: () => api.editor.childNodes.find((node) => node.dataset?.chatMentionChip === '1'),
      insertAtStart: (node) => api.editor.insertBefore(node, api.editor.childNodes[0] || null),
      makeText: (value) => new FakeText(value),
      setEditorText: (value) => { api.editor.textContent = value; },
      dispatchDeleteKey,
      historyUndo,
      historyRedo,
      useSkillDelete: (enabled) => { skillDeleteResult = !!enabled; },
      skillDeleteCalls: () => skillDeleteCalls,
    });
  `, {});
}

function chipsOf(editor: any): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1 && child.dataset && child.dataset.chatMentionChip === '1') out.push(child);
      walk(child);
    }
  };
  walk(editor);
  return out;
}

function loadFormReplay() {
  const fn = extractFunction('_mountChatInputForm');
  return vm.runInNewContext(`
    let sent = null;
    const currentCid = 'conv-form';
    const _convLog = { warn() {}, error() {} };
    const window = {
      renderChatInputForm(_host, _message, options) { this.options = options; },
    };
    async function apiFetch() {
      return { json: async () => ({
        ok: true,
        submission: { text: '<agent-input-submission />', agent_id: 'agent-form-owner' },
      }) };
    }
    async function sendInConversation(cid, text, extra) { sent = { cid, text, extra }; }
    ${fn}
    _mountChatInputForm({}, { dataset: { msgId: 'msg-form' } }, {
      _msg_id: 'msg-form', form: { form_id: 'form-1', submitted: false },
    }, { cid: 'conv-form' });
    ({ submit: (...args) => window.options.onSubmit(...args), sent: () => sent });
  `, {});
}

function loadPendingDraftRecovery() {
  const functions = [
    '_clonePendingSubmitDraft',
    '_holdPendingSubmitDraft',
    '_isExplicitSubmitAcceptance',
    '_restorePendingSubmitDraft',
    '_settlePendingSubmitDraft',
  ].map(extractFunction).join('\n\n');
  return vm.runInNewContext(`
    const _pendingSubmitDraftByCid = new Map();
    const _pendingSubmitDraftById = new Map();
    const input = { value: 'visible B draft' };
    let currentCid = 'conv-draft';
    const _quotesByCid = new Map();
    const attachments = new Map();
    let composer = null;
    let mentions = [];
    let taskRefRenders = 0;
    const document = { getElementById: (id) => id === 'chat-input' ? input : null };
    const window = {
      renderChatTaskRefChips: () => { taskRefRenders += 1; },
      composerMembers: {
        restoreDraftSnapshot: (_target, snapshot) => { composer = snapshot; },
        setMentionSidecar: (_target, snapshot) => { mentions = snapshot; },
        seedDraftTracking() {},
      },
    };
    function _chatAttachSet(cid, items) { attachments.set(cid, items); }
    function autoGrow() {}
    function _renderQuotePreview() {}
    function syncChatRichComposerFromTextarea() {}
    ${functions}
    ({
      hold: _holdPendingSubmitDraft,
      settle: _settlePendingSubmitDraft,
      input,
      quotes: (cid = 'conv-draft') => _quotesByCid.get(cid),
      attachments: (cid = 'conv-draft') => attachments.get(cid),
      composer: () => composer,
      mentions: () => mentions,
      taskRefRenders: () => taskRefRenders,
      pending: (cid = 'conv-draft') => _pendingSubmitDraftByCid.get(cid),
      setCurrentCid: (cid) => { currentCid = cid; },
    });
  `, {});
}

function loadSubmitIntentHarness() {
  const functions = [
    '_clonePendingSubmitDraft',
    '_holdPendingSubmitDraft',
    '_isExplicitSubmitAcceptance',
    '_settlePendingSubmitDraft',
    '_newSubmitRequestId',
    '_submitRequestIdFor',
  ].map(extractFunction).join('\n\n');
  return vm.runInNewContext(`
    const _submitIntentByCid = new Map();
    const _pendingSubmitDraftByCid = new Map();
    const _pendingSubmitDraftById = new Map();
    function _restorePendingSubmitDraft() {}
    ${functions}
    ({
      next: (cid, text) => _newSubmitRequestId(cid, text),
      stable: (cid, text) => _submitRequestIdFor(cid, text),
      hold: (cid, id, draft, text) => _holdPendingSubmitDraft(cid, id, draft, text),
      settle: (cid, id, result) => _settlePendingSubmitDraft(cid, id, result),
    });
  `, {});
}

function loadRecipientRoutingFields() {
  const functions = [
    '_normaliseRecipientSnapshot',
    '_recipientRoutingFields',
  ].map(extractFunction).join('\n\n');
  return vm.runInNewContext(`
    const _COMMANDER = { kind: 'commander', id: 'commander', name: 'CogSeed' };
    function _normRecipient(value) { return value; }
    ${functions}
    _recipientRoutingFields;
  `, {});
}

describe('正文点名标记（FR-004/FR-005）', () => {
  it('已注册 Agent 名渲染成绑定身份的不可编辑 chip，值无损往返', () => {
    const value = '@Codex 解释这段代码';
    const c = loadEditor([{ id: 'cli-codex', name: 'Codex', start: 0, end: 7, text: '@Codex ' }]);
    const editor = c.render(value);
    const chips = chipsOf(editor);
    expect(chips).toHaveLength(1);
    expect(chips[0].dataset.agentId).toBe('cli-codex');
    expect(chips[0].dataset.agentName).toBe('Codex');
    expect(chips[0].contentEditable).toBe('false');
    expect(chips[0].textContent).toBe('@Codex');
    expect(c.serialize(editor)).toBe(value);
  });

  it('CJK 名称与多个标记混排时字符流不变', () => {
    const value = '@集成验证Agent 先做方案，@Codex 再验证';
    const c = loadEditor([
      { id: 'task-a', name: '集成验证Agent', start: 0, end: 11, text: '@集成验证Agent ' },
      { id: 'cli-codex', name: 'Codex', start: 16, end: 23, text: '@Codex ' },
    ]);
    const editor = c.render(value);
    expect(chipsOf(editor).map((el) => el.dataset.agentId)).toEqual(['task-a', 'cli-codex']);
    expect(c.serialize(editor)).toBe(value);
  });

  it('未知名称与纯文本保持文本节点，不产生执行者 chip', () => {
    const c = loadEditor();
    const value = 'a@Codex.com 与 @Nobody 都只是文字';
    const editor = c.render(value);
    expect(chipsOf(editor)).toHaveLength(0);
    expect(c.serialize(editor)).toBe(value);
  });

  it('从 DOM 整块移除 chip 后序列化不再包含该标记', () => {
    const c = loadEditor([{ id: 'cli-codex', name: 'Codex', start: 0, end: 7, text: '@Codex ' }]);
    const editor = c.render('@Codex 解释这段代码');
    const chip = chipsOf(editor)[0];
    // 浏览器的整块删除就是把不可编辑节点整体摘掉（chip 自带尾随空格）。
    chip.parentNode.removeChild(chip);
    expect(c.serialize(editor)).toBe('解释这段代码');
  });

  it('chip 的序列化长度与实际字符数一致（光标/选区索引不漂移）', () => {
    const c = loadEditor([{ id: 'cli-codex', name: 'Codex', start: 0, end: 7, text: '@Codex ' }]);
    const editor = c.render('@Codex 看这个');
    const chip = chipsOf(editor)[0];
    expect(c.textLength(chip)).toBe('@Codex '.length);
  });

  it('粘贴的已注册名字仍是纯文本，不会被重渲染成身份 chip', () => {
    const c = loadEditor();
    const editor = c.render('@Codex 只是粘贴文本');
    expect(chipsOf(editor)).toHaveLength(0);
    expect(c.serialize(editor)).toBe('@Codex 只是粘贴文本');
  });

  it('拒绝从伪造 DOM data 属性反向建立点名身份', () => {
    const c = loadEditor();
    expect(c.forgedMention()).toEqual([]);
  });

  it('粘贴只有 HTML 时也阻止默认插入，不接受外来 chip 标记', () => {
    const c = loadPasteHarness();
    let prevented = false;
    c.paste({
      clipboardData: {
        files: [],
        getData(type) {
          return type === 'text/html'
            ? '<span data-chat-mention-chip="1" data-agent-id="cli-codex">@Codex</span>'
            : '';
        },
      },
      preventDefault() { prevented = true; },
    });
    expect(prevented).toBe(true);
    expect(c.inserted()).toEqual([]);
  });

  it('chooser 点名只在真实 historyUndo 恢复，redo 与同名输入/粘贴保持无身份', () => {
    const c = loadMentionUndoHarness();
    const chip = c.firstChip();
    expect(chip.dataset.agentId).toBe('cli-codex');
    expect(c.members.getMembers('conversation').map((member: any) => member.id)).toEqual(['cli-codex']);

    chip.parentNode.removeChild(chip);
    c.editor.emitInput('deleteContentBackward');
    expect(c.textarea.value).toBe('task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);

    c.insertAtStart(chip);
    c.editor.emitInput('historyUndo');
    expect(c.textarea.value).toBe('@Codex task');
    expect(c.firstChip()?.dataset.agentId).toBe('cli-codex');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual(['cli-codex']);
    expect(c.members.getMembers('conversation').map((member: any) => member.id)).toEqual(['cli-codex']);

    chip.parentNode.removeChild(chip);
    c.editor.emitInput('historyRedo');
    expect(c.textarea.value).toBe('task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);

    c.editor.appendChild(chip);
    c.editor.emitInput('historyUndo');
    expect(c.textarea.value).toBe('task@Codex ');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);

    c.setEditorText('task');
    c.editor.emitInput('deleteContentBackward');
    c.insertAtStart(c.makeText('@Codex '));
    c.editor.emitInput('insertText');
    expect(c.textarea.value).toBe('@Codex task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);

    c.setEditorText('task');
    c.editor.emitInput('deleteContentBackward');
    c.insertAtStart(c.makeText('@Codex '));
    c.editor.emitInput('insertFromPaste');
    expect(c.textarea.value).toBe('@Codex task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);
  });

  it.each(['Backspace', 'Delete'])('%s 让 contenteditable 原生整块删除点名并进入 undo/redo 历史', (key) => {
    const c = loadMentionUndoHarness();
    const deletion = c.dispatchDeleteKey(key);

    expect(deletion).toEqual({
      prevented: false,
      removedAsNode: true,
      chipText: '@Codex',
    });
    expect(c.textarea.value).toBe('task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);

    c.historyUndo();
    expect(c.firstChip()?.dataset.agentId).toBe('cli-codex');
    expect(c.textarea.value).toBe('@Codex task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual(['cli-codex']);
    expect(c.members.getMembers('conversation').map((member: any) => member.id)).toEqual(['cli-codex']);

    c.historyRedo();
    expect(c.firstChip()).toBeUndefined();
    expect(c.textarea.value).toBe('task');
    expect(c.members.mentionIdsForTarget('conversation', c.textarea.value)).toEqual([]);
    expect(c.members.getMembers('conversation')).toEqual([]);
  });

  it('技能 token 的既有 keydown 删除仍拦截浏览器默认动作', () => {
    const c = loadMentionUndoHarness();
    c.useSkillDelete(true);
    const deletion = c.dispatchDeleteKey('Backspace');
    expect(deletion.prevented).toBe(true);
    expect(deletion.removedAsNode).toBe(false);
    expect(c.skillDeleteCalls()).toBe(1);
    expect(c.firstChip()?.dataset.agentId).toBe('cli-codex');
  });
});

describe('表单回放结构化路由', () => {
  it('使用后端返回的 agent_id，不从 submission.text 重建 @名字', async () => {
    const replay = loadFormReplay();
    await replay.submit('', { approved: true }, []);
    expect(replay.sent()).toEqual({
      cid: 'conv-form',
      text: '<agent-input-submission />',
      extra: {
        recipient_agent_id: 'agent-form-owner',
        recipient_origin: 'user_selection',
      },
    });
  });

  it('返回 Commander 通过结构化字段重置 floor，不依赖 @commander 文本', () => {
    const route = loadRecipientRoutingFields();
    expect(route({ kind: 'commander', id: 'commander', name: 'CogSeed', resetFloor: true }))
      .toEqual({ recipient_agent_id: 'commander', recipient_origin: 'user_selection' });
  });

  it('keeps an active external floor as a structured route', () => {
    const route = loadRecipientRoutingFields();
    expect(route({ kind: 'agent', id: 'agent-external', name: 'Remote', origin: 'active_floor' }))
      .toEqual({ recipient_agent_id: 'agent-external', recipient_origin: 'active_floor' });
  });
});

describe('提交接受前的完整草稿', () => {
  it('失败或未知结果在同一 submit id 下恢复文本、点名、引用、附件与执行选择', () => {
    const recovery = loadPendingDraftRecovery();
    const draft = {
      text: '@Reviewer 复核',
      mentions: [{ id: 'agent-b', name: 'Reviewer', start: 0, end: 10, text: '@Reviewer ' }],
      quotes: [{ source_msg_id: 'msg-quoted', text: '原始结论' }],
      attachments: [{ name: 'evidence.pdf', status: 'ready' }],
      composer: { members: [{ kind: 'agent', id: 'agent-b', name: 'Reviewer' }], sourceConfigs: { internal: { model: 'm1' } } },
    };
    const first = recovery.hold('conv-draft', 'req-stable', draft);
    expect(recovery.hold('conv-draft', 'req-stable', { text: 'changed' })).toEqual(first);
    recovery.settle('conv-draft', 'req-stable', { started: false, errored: true, reason: 'unknown' });
    expect(recovery.input.value).toBe(draft.text);
    expect(recovery.quotes()).toEqual(draft.quotes);
    expect(recovery.attachments()).toEqual(draft.attachments);
    expect(recovery.composer()).toEqual(draft.composer);
    expect(recovery.mentions()).toEqual(draft.mentions);
    expect(recovery.taskRefRenders()).toBe(1);
    expect(recovery.pending().id).toBe('req-stable');
  });

  it.each([
    ['已有会话', 'conv-draft'],
    ['新建会话首条', 'conv-created-from-new-chat'],
  ])('%s 的乐观 started + 服务端拒绝不得清除草稿', (_label, cid) => {
    const recovery = loadPendingDraftRecovery();
    const draft = {
      text: '@Reviewer 复核',
      mentions: [{ id: 'agent-b', name: 'Reviewer', start: 0, end: 10, text: '@Reviewer ' }],
      quotes: [{ source_msg_id: 'msg-quoted', text: '原始结论' }],
      attachments: [{ name: 'evidence.pdf', status: 'ready' }],
      composer: { members: [{ kind: 'agent', id: 'agent-b', name: 'Reviewer' }], sourceConfigs: { internal: { model: 'm1' } } },
    };
    recovery.hold(cid, 'req-stable-optimistic', draft);
    recovery.setCurrentCid(cid);
    recovery.settle(cid, 'req-stable-optimistic', {
      started: true,
      errored: true,
      result: 'failure',
      reason: 'server_rejected',
    });
    expect(recovery.input.value).toBe(draft.text);
    expect(recovery.quotes(cid)).toEqual(draft.quotes);
    expect(recovery.attachments(cid)).toEqual(draft.attachments);
    expect(recovery.composer()).toEqual(draft.composer);
    expect(recovery.mentions()).toEqual(draft.mentions);
    expect(recovery.pending(cid)).toMatchObject({ id: 'req-stable-optimistic', draft });
  });

  it('rejects aborted or cancelled results and restores the full draft', () => {
    const recovery = loadPendingDraftRecovery();
    const draft = {
      text: '@Reviewer 复核',
      mentions: [{ id: 'agent-b', name: 'Reviewer', start: 0, end: 10, text: '@Reviewer ' }],
      quotes: [{ source_msg_id: 'msg-quoted', text: '原始结论' }],
      attachments: [{ name: 'evidence.pdf', status: 'ready' }],
      composer: { members: [{ kind: 'agent', id: 'agent-b', name: 'Reviewer' }] },
    };
    recovery.hold('conv-draft', 'req-aborted', draft);
    recovery.settle('conv-draft', 'req-aborted', { started: true, aborted: true });
    expect(recovery.input.value).toBe(draft.text);
    expect(recovery.pending().id).toBe('req-aborted');

    recovery.hold('conv-draft', 'req-cancelled', draft);
    recovery.settle('conv-draft', 'req-cancelled', { started: true, result: 'cancelled' });
    expect(recovery.input.value).toBe(draft.text);
    expect(recovery.pending().id).toBe('req-cancelled');
  });

  it('settles a draft only for an exact server acceptance receipt', () => {
    const recovery = loadPendingDraftRecovery();
    const draft = { text: '@Reviewer 复核' };
    recovery.hold('conv-draft', 'req-exact', draft);

    expect(recovery.settle('conv-draft', 'req-exact', {
      accepted: true,
      cid: 'other-conversation',
      submit_request_id: 'req-exact',
    })).toBe(false);
    expect(recovery.pending()).toMatchObject({ id: 'req-exact', draft });

    expect(recovery.settle('conv-draft', 'req-exact', {
      accepted: true,
      cid: 'conv-draft',
      submit_request_id: 'req-exact',
    })).toBe(true);
    expect(recovery.pending()).toBeUndefined();
  });

  it('keeps a failed draft pending without mutating a different visible conversation', () => {
    const recovery = loadPendingDraftRecovery();
    const draft = {
      text: 'A private draft',
      mentions: [{ id: 'agent-a', name: 'A', start: 0, end: 3, text: '@A ' }],
      quotes: [{ source_msg_id: 'a-quote', text: 'A quote' }],
      attachments: [{ name: 'a.pdf', status: 'ready' }],
      composer: { members: [{ kind: 'agent', id: 'agent-a', name: 'A' }] },
    };
    recovery.hold('conv-a', 'req-a', draft);
    recovery.setCurrentCid('conv-b');
    recovery.settle('conv-a', 'req-a', { started: true, errored: true, result: 'failure' });
    expect(recovery.input.value).toBe('visible B draft');
    expect(recovery.pending('conv-a')).toMatchObject({ id: 'req-a', draft });
    expect(recovery.quotes('conv-a')).toBeUndefined();
    expect(recovery.attachments('conv-a')).toBeUndefined();
  });

  it('allocates a distinct submit id for each queued duplicate intent', () => {
    const intents = loadSubmitIntentHarness();
    const first = intents.stable('conv-queue', 'same text');
    const queued = intents.next('conv-queue', 'same text');
    expect(queued).not.toBe(first);
    expect(intents.next('conv-queue', 'same text')).not.toBe(queued);
  });

  it('reuses the restored submit id when a queued duplicate overwrote the current intent', () => {
    const intents = loadSubmitIntentHarness();
    const active = intents.stable('conv-queue', 'same text');
    intents.hold('conv-queue', active, { text: 'same text' }, 'same text');
    const queued = intents.next('conv-queue', 'same text');
    intents.hold('conv-queue', queued, { text: 'same text' }, 'same text');
    intents.settle('conv-queue', active, { started: true, errored: true, result: 'failure' });

    expect(intents.stable('conv-queue', 'same text')).toBe(active);
  });

  it('keeps independent active and queued snapshots under one conversation', () => {
    const recovery = loadPendingDraftRecovery();
    recovery.hold('conv-draft', 'req-active', { text: 'active draft' });
    recovery.hold('conv-draft', 'req-queued', { text: 'queued draft' });
    recovery.settle('conv-draft', 'req-active', { started: true, errored: true, result: 'failure' });
    expect(recovery.input.value).toBe('active draft');
    expect(recovery.pending('conv-draft').id).toBe('req-active');
  });
});

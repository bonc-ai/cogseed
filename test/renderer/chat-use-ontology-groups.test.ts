import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const chatUseSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-use.js'), 'utf8');

interface FakeInput {
  id: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  dataset: Record<string, string>;
  setSelectionRange(start: number, end: number): void;
  setRangeText(text: string, start: number, end: number, mode: string): void;
  addEventListener(type: string, fn: (...args: any[]) => void): void;
  dispatchEvent(ev: { type: string }): void;
  focus(): void;
}

function makeInput(id: string): FakeInput {
  const self: FakeInput = {
    id,
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    dataset: {},
    setSelectionRange(start, end) { self.selectionStart = start; self.selectionEnd = end; },
    setRangeText(text, start, end, mode) {
      self.value = self.value.slice(0, start) + text + self.value.slice(end);
      if (mode === 'end') { self.selectionStart = self.selectionEnd = start + text.length; }
    },
    addEventListener() {},
    dispatchEvent() {},
    focus() {},
  };
  return self;
}

/** Loads the chat-use.js "core" block (same slice the existing
 *  chat-use-inline-chips.test.ts uses) into a fresh vm context, with a fake
 *  DOM providing one input per target and a fake window.orkas.invoke that the
 *  test controls. */
function loadChatUseHelpers(opts: { invoke?: (channel: string, payload: any) => Promise<any> } = {}) {
  const start = chatUseSource.indexOf('// ─── Chat-input inline use chips');
  const end = chatUseSource.indexOf('// Chat composers are part of the startup shell', start);
  if (start < 0 || end < 0) throw new Error('missing chat use helper block');
  const block = chatUseSource.slice(start, end);

  const inputs: Record<string, FakeInput> = {
    'new-chat-input': makeInput('new-chat-input'),
    'chat-input': makeInput('chat-input'),
    'project-chat-input': makeInput('project-chat-input'),
    'auto-task-input': makeInput('auto-task-input'),
  };

  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  const invoke = async (channel: string, payload: any) => {
    invokeCalls.push({ channel, payload });
    if (opts.invoke) return opts.invoke(channel, payload);
    return { ok: true, content: '' };
  };

  const context = vm.createContext({
    console,
    currentCid: '',
    _saveDraft() {},
    escapeHtml(value: string) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      } as Record<string, string>)[ch]);
    },
    t(key: string, vars: Record<string, any> = {}) {
      const table: Record<string, string> = {
        'connectors.use_label': 'Connector: {connector}',
        'connectors.use_prefix': 'Use {connector} connector: {content}',
        'connectors.inline_text': '{connector} connector',
        'skills.use_label': 'Skill: {skill}',
        'skills.use_prefix': 'Use {skill} skill: {content}',
        'skills.inline_text': '{skill} skill',
        'agent_picker.ontology_group': 'Memory group',
        'personalOntology.use_prefix': 'Please focus on 【{title}】this turn: {content}',
      };
      let text = table[key] || key;
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll('{' + k + '}', String(v));
      return text;
    },
    document: {
      getElementById(id: string) { return inputs[id] || null; },
      querySelectorAll() { return []; },
    },
    window: { orkas: { invoke } },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
  });

  vm.runInContext(block, context, { filename: 'chat-use.js' });

  return {
    inputs,
    invokeCalls,
    normalize: context._normalizeChatUseSelection,
    tokenFor: context._chatUseTokenFor,
    getGroups: context.getChatUseOntologyGroups,
    addGroup: context.addChatUseOntologyGroup,
    removeGroup: context.removeChatUseOntologyGroup,
    getSelections: context.getChatUseSelections,
    transformAsync: context.transformWithChatUseAsync,
    transformTokensAsync: context.transformChatUseTokensAsync,
    transformSync: context.transformWithChatUse,
    mirror: context._renderChatUseMirrorHtml,
    labelParts: context._chatUseLabelParts,
  };
}

describe('chat-use › ontology_group normalization', () => {
  it('normalizes an ontology_group selection like skill/connector', () => {
    const h = loadChatUseHelpers();
    expect(h.normalize({ kind: 'ontology_group', id: 'g1', name: '工作偏好' }))
      .toEqual({ kind: 'ontology_group', id: 'g1', name: '工作偏好' });
  });

  it('rejects unknown kinds (not silently coerced to skill)', () => {
    const h = loadChatUseHelpers();
    expect(h.normalize({ kind: 'bogus', id: 'x' })).toBeNull();
  });
});

describe('chat-use › multi-select add/remove (no clearing of other tokens)', () => {
  it('addChatUseOntologyGroup inserts a token without touching existing ones', () => {
    const h = loadChatUseHelpers();
    h.inputs['chat-input'].value = 'hello';
    h.inputs['chat-input'].selectionStart = h.inputs['chat-input'].selectionEnd = 5;

    const ok = h.addGroup('conversation', 'g1', 'Work preferences');
    expect(ok).toBe(true);
    expect(h.inputs['chat-input'].value).toContain('hello');
    const groups = h.getGroups('conversation');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'ontology_group', id: 'g1', name: 'Work preferences' });
  });

  it('selecting group B after group A keeps both — this is the multi-select behavior being tested', () => {
    const h = loadChatUseHelpers();
    h.addGroup('conversation', 'g1', 'Group A');
    h.addGroup('conversation', 'g2', 'Group B');

    const groups = h.getGroups('conversation');
    expect(groups.map((g: any) => g.id).sort()).toEqual(['g1', 'g2']);
  });

  it('does not insert a duplicate token for the same group id twice', () => {
    const h = loadChatUseHelpers();
    h.addGroup('conversation', 'g1', 'Group A');
    const secondAdd = h.addGroup('conversation', 'g1', 'Group A');
    expect(secondAdd).toBe(false);
    expect(h.getGroups('conversation')).toHaveLength(1);
  });

  it('removeChatUseOntologyGroup removes only the targeted group, keeps the rest', () => {
    const h = loadChatUseHelpers();
    h.addGroup('conversation', 'g1', 'Group A');
    h.addGroup('conversation', 'g2', 'Group B');

    const removed = h.removeGroup('conversation', 'g1');
    expect(removed).toBe(true);
    const groups = h.getGroups('conversation');
    expect(groups.map((g: any) => g.id)).toEqual(['g2']);
  });

  it('removeChatUseOntologyGroup on an id not present is a no-op', () => {
    const h = loadChatUseHelpers();
    h.addGroup('conversation', 'g1', 'Group A');
    const removed = h.removeGroup('conversation', 'does-not-exist');
    expect(removed).toBe(false);
    expect(h.getGroups('conversation')).toHaveLength(1);
  });

  it('ontology_group tokens coexist with a skill token in the same input (multi-kind, not just multi-group)', () => {
    const h = loadChatUseHelpers();
    const skillToken = h.tokenFor({ kind: 'skill', id: 'research', name: 'Research' });
    h.inputs['chat-input'].value = `Use ${skillToken} `;
    h.inputs['chat-input'].selectionStart = h.inputs['chat-input'].selectionEnd = h.inputs['chat-input'].value.length;

    h.addGroup('conversation', 'g1', 'Group A');

    const selections = h.getSelections('conversation');
    expect(selections.some((s: any) => s.kind === 'skill')).toBe(true);
    expect(selections.some((s: any) => s.kind === 'ontology_group')).toBe(true);
  });

  it('different targets (new-chat vs conversation) track independent group selections', () => {
    const h = loadChatUseHelpers();
    h.addGroup('new-chat', 'g1', 'A');
    h.addGroup('conversation', 'g2', 'B');
    expect(h.getGroups('new-chat').map((g: any) => g.id)).toEqual(['g1']);
    expect(h.getGroups('conversation').map((g: any) => g.id)).toEqual(['g2']);
  });
});

describe('chat-use › transformWithChatUseAsync — the actual emphasis path', () => {
  it('fetches the group content over IPC and inlines it with the use_prefix template, in place of the token', async () => {
    const h = loadChatUseHelpers({
      invoke: async (channel, payload) => {
        expect(channel).toBe('personalOntology.groups.read');
        expect(payload).toEqual({ groupId: 'g1' });
        return { ok: true, content: '喜欢直接、简洁的回答' };
      },
    });
    const token = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: '沟通偏好' });
    const text = `请注意 ${token} 谢谢`;

    const out = await h.transformAsync(text);
    expect(out).toBe('请注意 Please focus on 【沟通偏好】this turn: 喜欢直接、简洁的回答 谢谢');
  });

  it('falls back to just the group name (no empty template) when the group content is empty', async () => {
    const h = loadChatUseHelpers({ invoke: async () => ({ ok: true, content: '' }) });
    const token = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: '空分组' });
    const out = await h.transformAsync(`before ${token} after`);
    expect(out).toBe('before 空分组 after');
    expect(out).not.toContain('Please focus on'); // no empty-content template applied
  });

  it('falls back to the group name when the IPC read fails', async () => {
    const h = loadChatUseHelpers({ invoke: async () => ({ ok: false, error: 'group not found' }) });
    const token = h.tokenFor({ kind: 'ontology_group', id: 'gone', name: '已删除分组' });
    const out = await h.transformAsync(`x ${token} y`);
    expect(out).toBe('x 已删除分组 y');
  });

  it('handles multiple distinct groups in one message, each fetched and inlined independently', async () => {
    const contents: Record<string, string> = { g1: 'content one', g2: 'content two' };
    const h = loadChatUseHelpers({
      invoke: async (_channel, payload) => ({ ok: true, content: contents[payload.groupId] || '' }),
    });
    const t1 = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: 'Group1' });
    const t2 = h.tokenFor({ kind: 'ontology_group', id: 'g2', name: 'Group2' });
    const out = await h.transformAsync(`${t1} and ${t2}`);
    expect(out).toContain('content one');
    expect(out).toContain('content two');
  });

  it('dedups IPC reads when the same group appears twice in the text (single fetch, reused for both)', async () => {
    let readCount = 0;
    const h = loadChatUseHelpers({
      invoke: async (channel) => {
        if (channel === 'personalOntology.groups.read') readCount += 1;
        return { ok: true, content: 'shared content' };
      },
    });
    const t1 = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: 'G' });
    const out = await h.transformAsync(`${t1} twice ${t1}`);
    expect(readCount).toBe(1);
    expect(out.match(/shared content/g)).toHaveLength(2);
  });

  it('still applies the skill use_prefix template for a legacy single skill selection passed alongside', async () => {
    const h = loadChatUseHelpers({ invoke: async () => ({ ok: true, content: '' }) });
    const out = await h.transformAsync('plain text', { kind: 'skill', name: 'Reader' });
    expect(out).toBe('Use Reader skill: plain text');
  });

  it('connector use_prefix still wraps the whole (already-inlined) content', async () => {
    const h = loadChatUseHelpers({ invoke: async () => ({ ok: true, content: 'group body' }) });
    const groupToken = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: 'G' });
    const out = await h.transformAsync(groupToken, { kind: 'connector', name: 'GitHub' });
    expect(out).toBe('Use GitHub connector: Please focus on 【G】this turn: group body');
  });

  it('mirrors the label for an ontology_group token using the "Memory group: <name>" pattern', () => {
    const h = loadChatUseHelpers();
    const parts = h.labelParts({ kind: 'ontology_group', id: 'g1', name: '工作偏好' });
    expect(parts.label).toBe('Memory group：工作偏好');
    expect(parts.name).toBe('工作偏好');
  });

  it('renders an ontology_group token as an inline mirror chip', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: '工作偏好' });
    const html = h.mirror(`Use ${token} now`, (s: string) => s);
    expect(html).toContain('chat-use-inline-chip');
    expect(html).toContain('工作偏好');
  });
});

describe('chat-use › sync transformWithChatUse leaves ontology_group tokens as a plain name (not the real emphasis path)', () => {
  it('sync path never calls IPC — token is inlined as just its name', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'ontology_group', id: 'g1', name: '工作偏好' });
    const out = h.transformSync(`before ${token} after`);
    expect(out).toBe('before 工作偏好 after');
    expect(h.invokeCalls).toEqual([]);
  });
});

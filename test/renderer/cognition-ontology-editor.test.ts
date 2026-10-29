import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/** 等到 predicate 成立（有界轮询）。去抖定时器在满载 runner 上会比固定 sleep 晚，
 *  固定毫秒数等的是「机器快慢」而不是「代码有没有发起第一次 IPC」。 */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function editorApi(): any {
  const window: Record<string, any> = {};
  runInNewContext(readFileSync(resolve('src/renderer/modules/cognition-ontology-editor.js'), 'utf8'),
    { window, setTimeout, clearTimeout, Date, Math, JSON, Map, Set, Object, Promise });
  return window.CogOntologyEditor;
}

function fixture() {
  let doc: any = { revision: 1, records: {
    a: { id: 'a', kind: 'entity', moduleId: 'module', status: 'active', source: { kind: 'user' }, version: 1, name: '甲', description: '旧说明' },
  }, history: [] };
  const commits: any[] = [], statuses: string[] = [];
  const options = {
    ownerId: 'owner', delay: 60_000,
    getDocument: () => doc,
    onStatus: (status: string) => statuses.push(status),
    onCommit: (result: any) => { commits.push(result); doc = result.ontology; },
  };
  const succeed = (command: any, recordId = 'a') => {
    const record = { ...doc.records[recordId], ...command.changes, version: doc.records[recordId].version + 1 };
    const result = { recordId, receipt: { commandId: command.commandId, revision: doc.revision + 1, changedIds: [recordId] },
      ontology: { revision: doc.revision + 1, records: { ...doc.records, [recordId]: record },
        history: [...doc.history, { commandId: command.commandId, after: record }] } };
    return result;
  };
  return { options, succeed, commits, statuses, getDoc: () => doc, setDoc: (next: any) => { doc = next; } };
}

describe('ontology document autosave queue', () => {
  it('serializes edits and verifies the saved value before clearing the draft', async () => {
    const fixtureState = fixture();
    const calls: any[] = [];
    const editor = editorApi().create({ ...fixtureState.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      return fixtureState.succeed(command);
    } });
    expect(editor.enqueue('a', 'name', '新名字')).toBe(true);
    expect(editor.enqueue('a', 'description', '新说明')).toBe(true);
    expect(await editor.flush()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].changes).toEqual({ name: '新名字', description: '新说明' });
    expect(fixtureState.getDoc().records.a).toMatchObject({ name: '新名字', description: '新说明', version: 2 });
    expect(editor.hasPending()).toBe(false);
    expect(fixtureState.statuses.at(-1)).toBe('saved');
    editor.destroy();
  });

  it('retains a changed field typed during an in-flight save and commits it next', async () => {
    const fixtureState = fixture();
    let finishFirst!: (value: any) => void;
    const calls: any[] = [];
    const editor = editorApi().create({ ...fixtureState.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      if (calls.length === 1) return new Promise(resolve => { finishFirst = resolve; });
      return fixtureState.succeed(command);
    } });
    editor.enqueue('a', 'name', '第一版');
    const running = editor.flush();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    editor.enqueue('a', 'name', '第二版');
    finishFirst(fixtureState.succeed(calls[0]));
    expect(await running).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].changes).toEqual({ name: '第二版' });
    expect(calls[1].expectedVersion).toBe(2);
    expect(fixtureState.getDoc().records.a.name).toBe('第二版');
    editor.destroy();
  });

  it('flushes a fresh second draft before destroy while an automatic save is still running', async () => {
    const state = fixture();
    state.setDoc({ ...state.getDoc(), records: { ...state.getDoc().records,
      b: { ...state.getDoc().records.a, id: 'b', name: '乙' } } });
    const calls: any[] = [];
    let finishFirst!: (value: any) => void;
    const editor = editorApi().create({ ...state.options, delay: 40,
      invoke: async (_channel: string, command: any) => {
        calls.push(command);
        if (calls.length === 1) return new Promise(resolve => { finishFirst = resolve; });
        return state.succeed(command, command.recordId);
      } });
    editor.enqueue('a', 'name', '新甲');
    // 去抖 40ms：等到第一次 IPC 真的发起，再确认「只有一次且仍挂起」。
    await until(() => calls.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1); // timer started drain(false), first IPC is still pending
    editor.enqueue('b', 'name', '新乙');
    const flushed = editor.flush(); // navigation/unmount requests a forced flush
    finishFirst(state.succeed(calls[0], 'a'));
    const completed = await flushed;
    editor.destroy(); // clears any debounce timer left by the first drain
    expect(completed).toBe(true);
    expect(calls.map(command => command.recordId)).toEqual(['a', 'b']);
    expect(state.getDoc().records.b.name).toBe('新乙');
    expect(editor.hasPending()).toBe(false);
  });

  it('retries a transport failure with the same command ID and does not claim it saved early', async () => {
    const fixtureState = fixture();
    const calls: any[] = [];
    const editor = editorApi().create({ ...fixtureState.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      if (calls.length === 1) throw Object.assign(new Error('network lost'), { code: 'transport_error' });
      return fixtureState.succeed(command);
    } });
    editor.enqueue('a', 'name', '新名字');
    expect(await editor.flush()).toBe(false);
    expect(editor.hasPending()).toBe(true);
    expect(fixtureState.statuses.at(-1)).toBe('error');
    expect(await editor.retry('a')).toBe(true);
    expect(calls[1].commandId).toBe(calls[0].commandId);
    expect(fixtureState.getDoc().records.a.name).toBe('新名字');
    editor.destroy();
  });

  it('rebases a different record revision and refuses an unverifiable receipt', async () => {
    const fixtureState = fixture();
    const calls: any[] = [];
    const editor = editorApi().create({ ...fixtureState.options, invoke: async (channel: string, command: any) => {
      if (channel === 'cognition.ontology.snapshot') return { ontology: fixtureState.getDoc() };
      calls.push(command);
      if (calls.length === 1) {
        fixtureState.setDoc({ ...fixtureState.getDoc(), revision: 2 });
        throw Object.assign(new Error('stale revision'), { code: 'baseline_changed' });
      }
      return { ...fixtureState.succeed(command), receipt: { commandId: command.commandId, revision: 3, changedIds: [] } };
    } });
    editor.enqueue('a', 'name', '新名字');
    expect(await editor.flush()).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1].expectedRevision).toBe(2);
    expect(calls[1].commandId).toBe(calls[0].commandId);
    expect(editor.hasPending()).toBe(true);
    expect(fixtureState.statuses.at(-1)).toBe('error');
    editor.destroy();
  });

  it('uses the latest revision when serializing edits for different records', async () => {
    const state = fixture();
    state.setDoc({ ...state.getDoc(), records: { ...state.getDoc().records,
      b: { ...state.getDoc().records.a, id: 'b', name: '乙' } } });
    const calls: any[] = [];
    const editor = editorApi().create({ ...state.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      return state.succeed(command, command.recordId);
    } });
    editor.enqueue('a', 'name', '新甲');
    editor.enqueue('b', 'name', '新乙');
    expect(await editor.flush()).toBe(true);
    expect(calls.map(command => command.expectedRevision)).toEqual([1, 2]);
    expect(state.getDoc().records.a.name).toBe('新甲');
    expect(state.getDoc().records.b.name).toBe('新乙');
    editor.destroy();
  });

  it('moves a draft to the successor fact after a correction and keeps later edits', async () => {
    const state = fixture();
    state.setDoc({ ...state.getDoc(), records: { fact: { id: 'fact', kind: 'assertion', moduleId: 'module',
      status: 'active', source: { kind: 'user' }, version: 1, object: { kind: 'literal', valueType: 'number', value: 20 } } } });
    let finishFirst!: (result: any) => void;
    const calls: any[] = [];
    const editor = editorApi().create({ ...state.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      if (calls.length === 1) return new Promise(resolve => { finishFirst = resolve; });
      const successor = { ...state.getDoc().records.successor, object: { kind: 'literal', valueType: 'number', value: command.changes['object.value'] }, version: 2 };
      return { recordId: 'successor', receipt: { commandId: command.commandId, revision: 3, changedIds: ['successor'] },
        ontology: { revision: 3, records: { ...state.getDoc().records, successor },
          history: [...state.getDoc().history, { commandId: command.commandId, after: successor }] } };
    } });
    editor.enqueue('fact', 'object.value', 21);
    const running = editor.flush();
    await Promise.resolve();
    editor.enqueue('fact', 'object.value', 22);
    const original = state.getDoc().records.fact;
    const successor = { ...original, id: 'successor', version: 1, object: { ...original.object, value: 21 } };
    finishFirst({ recordId: 'successor', receipt: { commandId: calls[0].commandId, revision: 2, changedIds: ['fact', 'successor'] },
      ontology: { revision: 2, records: { fact: { ...original, status: 'corrected' }, successor },
        history: [{ commandId: calls[0].commandId, after: successor }] } });
    expect(await running).toBe(true);
    expect(editor.resolveId('fact')).toBe('successor');
    expect(calls[1].recordId).toBe('successor');
    expect(calls[1].changes['object.value']).toBe(22);
    expect(state.getDoc().records.successor.object.value).toBe(22);
    editor.destroy();
  });

  it('merges an in-flight correction remainder into an existing successor draft without losing its newer values or retry state', async () => {
    const state = fixture();
    const original = { id: 'fact', kind: 'assertion', moduleId: 'module', status: 'active', source: { kind: 'user' },
      version: 1, subjectId: 'person-a', certainty: 'confirmed', object: { kind: 'literal', valueType: 'number', value: 20 } };
    state.setDoc({ revision: 1, records: { fact: original }, history: [] });
    let finishFirst!: (result: any) => void;
    const calls: any[] = [];
    const editor = editorApi().create({ ...state.options, invoke: async (_channel: string, command: any) => {
      calls.push(command);
      if (calls.length > 1) throw Object.assign(new Error('unexpected successor save'), { code: 'transport_error' });
      return new Promise(resolve => { finishFirst = resolve; });
    } });
    editor.enqueue('fact', 'object.value', 21);
    const running = editor.flush();
    await Promise.resolve();
    editor.enqueue('fact', 'object.value', 22);
    editor.enqueue('fact', 'subjectId', 'person-b');
    editor.getDrafts().fact.changedAt = 100;
    const successor = { ...original, id: 'successor', version: 1, object: { ...original.object, value: 21 } };
    state.setDoc({ revision: 2, records: { fact: { ...original, status: 'corrected' }, successor }, history: [] });
    editor.enqueue('successor', 'object.value', 23);
    editor.enqueue('successor', 'certainty', 'inferred');
    const existing = editor.getDrafts().successor;
    existing.changedAt = 200;
    existing.command = { commandId: 'successor-retry', recordId: 'successor', changes: { 'object.value': 23 } };
    existing.error = { code: 'transport_error', message: 'retry needed' };
    finishFirst({ recordId: 'successor', receipt: { commandId: calls[0].commandId, revision: 2, changedIds: ['fact', 'successor'] },
      ontology: { revision: 2, records: state.getDoc().records, history: [{ commandId: calls[0].commandId, after: successor }] } });
    expect(await running).toBe(false);
    expect(calls).toHaveLength(1);
    expect(editor.getDrafts().successor.changes).toEqual({ 'object.value': 23, certainty: 'inferred', subjectId: 'person-b' });
    expect(editor.getDrafts().successor.baseVersion).toBe(1);
    expect(editor.getDrafts().successor.baseValues).toEqual({ 'object.value': 21, certainty: 'confirmed', subjectId: 'person-a' });
    expect(editor.getDrafts().successor.command.commandId).toBe('successor-retry');
    expect(editor.getDrafts().successor.error.code).toBe('transport_error');
    editor.destroy();
  });

  it('keeps the draft when the edited record itself changes at the server', async () => {
    const state = fixture();
    const calls: any[] = [];
    const editor = editorApi().create({ ...state.options, invoke: async (channel: string, command: any) => {
      if (channel === 'cognition.ontology.snapshot') return { ontology: state.getDoc() };
      calls.push(command);
      state.setDoc({ ...state.getDoc(), revision: 2, records: { a: { ...state.getDoc().records.a, version: 2, name: '别人修改' } } });
      throw Object.assign(new Error('stale revision'), { code: 'baseline_changed' });
    } });
    editor.enqueue('a', 'name', '我的修改');
    expect(await editor.flush()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(editor.getDrafts().a.changes.name).toBe('我的修改');
    expect(editor.getDrafts().a.error.code).toBe('baseline_changed');
    expect(state.getDoc().records.a.name).toBe('别人修改');
    editor.destroy();
  });

  it('restores an unsaved draft after reload and reports saved only after verification', async () => {
    const state = fixture(), stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) || null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); } };
    const first = editorApi().create({ ...state.options, storage, invoke: async () => { throw new Error('unexpected save'); } });
    first.enqueue('a', 'name', '未保存的名字');
    first.destroy();
    const second = editorApi().create({ ...state.options, storage,
      invoke: async (_channel: string, command: any) => state.succeed(command) });
    expect(second.getDrafts().a.changes.name).toBe('未保存的名字');
    expect(second.hasPending()).toBe(true);
    expect(state.statuses.at(-1)).toBe('pending');
    expect(await second.flush()).toBe(true);
    expect(state.getDoc().records.a.name).toBe('未保存的名字');
    expect(stored.size).toBe(0);
    second.destroy();
  });
});

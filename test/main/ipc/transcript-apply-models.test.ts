// 身份、发言与文件名均为合成测试样例；时间仅用于解析和顺序断言。
/**
 * transcript.correct.apply × 模型候选
 *
 * 三条要钉死的行为：
 *   1. 勾选并应用的模型建议只替换当前材料，不新增或修改长期词表；
 *   2. **没勾选就不许动正文**——尤其"没传 acceptedIds"时，绝不能因为
 *      applyCorrections 的"缺省=全部非 high"把模型建议静默全量应用；
 *   3. 合成 ref（model_*）不得污染词条台账（recordReplacement 只认词表 id）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uApplyModels';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-apply-models-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { userId: TEST_UID, user: { user_id: TEST_UID, created_at: new Date(0).toISOString() }, sender: {} };
}

const TEXT = '这个方案要例加老师确认一下排期。';
// 例加 在原文里的偏移
const AT = TEXT.indexOf('例加');
const MODEL = { start: AT, wrong: '例加', correct: '例甲', confidence: 0.95, reason: '合成名称同音错写' };

async function apply(payload: Record<string, unknown>) {
  const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
  return (invokeHandlers['transcript.correct.apply'] as (p: unknown, c: unknown) => Promise<any>)(
    { text: TEXT, docId: 'doc_1', ...payload }, ctx(),
  );
}

describe('model_* 候选接入 apply', () => {
  it('勾选模型建议只更正当前材料，长期词表保持为空', async () => {
    const result = await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    expect(result.result.text).toBe('这个方案要例甲老师确认一下排期。');
    expect(result.result.applied.map((a: any) => a.entryRef)).toContain('model_0');
    expect(result.glossaryWrites).toEqual({ created: 0, updated: 0, skipped: 0 });

    const glossary = await import('../../../src/main/features/transcript_glossary');
    const entries = glossary.listEntries(TEST_UID, { status: 'active' });
    expect(entries).toEqual([]);
  });

  it('只勾第 2 条时也真的应用但不形成词条（ref 要按扫描期编号走，不能按数组下标重编）', async () => {
    // 扫描期的 model_1 与 acceptedIds 必须保持一致，不能按 payload 数组下标重编。
    const second = { ...MODEL, entryRef: 'model_1', start: TEXT.indexOf('排期'), wrong: '排期', correct: '计划' };
    const result = await apply({
      models: [{ ...MODEL, entryRef: 'model_0' }, second],
      acceptedIds: ['model_1'],
    });
    expect(result.result.text).toBe('这个方案要例加老师确认一下计划。');
    expect(result.result.applied.map((a: any) => a.entryRef)).toEqual(['model_1']);
    expect(result.glossaryWrites).toEqual({ created: 0, updated: 0, skipped: 0 });

    const glossary = await import('../../../src/main/features/transcript_glossary');
    const entries = glossary.listEntries(TEST_UID, { status: 'active' });
    expect(entries).toEqual([]);
  });

  it('伪造的 ref（长得像词表条目 id）被忽略：只认 model_<数字>，不许冒充 g_*', async () => {
    const result = await apply({
      models: [{ ...MODEL, entryRef: 'g_deadbeef' }],
      acceptedIds: ['g_deadbeef', 'model_0'],
    });
    // 伪造 ref 被换成 model_0（数组下标兜底），因此它进不了词条台账的 replacedIn
    expect(result.result.applied.map((a: any) => a.entryRef)).toEqual(['model_0']);
    const glossary = await import('../../../src/main/features/transcript_glossary');
    expect(glossary.findEntry(TEST_UID, 'g_deadbeef')).toBeNull();
    expect(glossary.listEntries(TEST_UID, { status: 'active' })).toHaveLength(0);
  });

  it('**没勾选**就一个字都不改，也不写词表', async () => {
    const result = await apply({ models: [MODEL], acceptedIds: [] });
    expect(result.result.text).toBe(TEXT);
    expect(result.glossaryWrites).toMatchObject({ created: 0, updated: 0 });
    const glossary = await import('../../../src/main/features/transcript_glossary');
    expect(glossary.listEntries(TEST_UID, { status: 'active' })).toEqual([]);
  });

  it('没传 acceptedIds 时也不会静默全量应用（这是最危险的默认值）', async () => {
    const result = await apply({ models: [MODEL] });
    expect(result.result.text).toBe(TEXT);
    expect(result.result.applied).toEqual([]);
    expect(result.glossaryWrites).toMatchObject({ created: 0 });
  });

  it('span 与正文对不上（重扫/换稿后坐标错位）的候选被丢弃，不按脏坐标改正文', async () => {
    const result = await apply({
      models: [
        { ...MODEL, start: AT + 1 },                       // 错位
        { ...MODEL, start: 9999 },                          // 越界
        { ...MODEL, wrong: '不存在的词' },                   // 内容对不上
        MODEL,                                              // 唯一合法的一条
      ],
      acceptedIds: ['model_0', 'model_1', 'model_2', 'model_3'],
    });
    expect(result.droppedModels).toBe(3);
    expect(result.result.text).toBe('这个方案要例甲老师确认一下排期。');
    expect(result.glossaryWrites).toMatchObject({ created: 0, updated: 0 });
  });

  it('大小写/全角差异不算错位（折叠后比较）', async () => {
    const text = '这块是 COXY 在跟。';
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const result = await (invokeHandlers['transcript.correct.apply'] as any)(
      {
        text,
        docId: 'doc_c',
        models: [{ start: text.indexOf('COXY'), wrong: 'coxy', correct: 'Cogseed', confidence: 0.9 }],
        acceptedIds: ['model_0'],
      },
      ctx(),
    );
    expect(result.droppedModels).toBe(0);
    expect(result.result.text).toBe('这块是 Cogseed 在跟。');
  });

  it('台账不被合成 ref 污染：model_* 不出现在任何词条的 replacedIn 里', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(TEST_UID, { wrong: 'coxy', correct: 'Cogseed' });
    await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    for (const entry of glossary.listEntries(TEST_UID)) {
      for (const ref of entry.replacedIn) {
        expect(String(ref.runId)).not.toContain('model_');
      }
    }
    expect(glossary.findEntry(TEST_UID, 'model_0')).toBeNull();
  });

  it('已有词条继续应用并记录替换回执，但模型建议不改变已有规则或其作用域', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    const saved = glossary.upsertEntry(TEST_UID, { wrong: '例加', correct: '例甲', source: 'manual', docId: 'doc_1' }).entry!;
    const before = { wrong: saved.wrong, correct: saved.correct, source: saved.source, scope: saved.scope };
    const result = await apply({ acceptedIds: [saved.id] });
    expect(result.result.text).toBe('这个方案要例甲老师确认一下排期。');
    expect(result.glossaryWrites).toMatchObject({ created: 0, updated: 0 });
    expect(glossary.listEntries(TEST_UID)).toHaveLength(1);
    const current = glossary.findEntry(TEST_UID, saved.id)!;
    expect(current).toMatchObject(before);
    expect(current.replacedIn).toHaveLength(1);
    await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    expect(glossary.findEntry(TEST_UID, saved.id)).toMatchObject(before);
    expect(glossary.listEntries(TEST_UID)).toHaveLength(1);
  });

  it('当前材料应用后，再次扫描和其他文档都不会自动获得新词表规则', async () => {
    await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'doc_1' }, ctx());
    expect(scan.candidates).toEqual([]);
    const other = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'doc_other' }, ctx());
    expect(other.candidates).toEqual([]);
  });
});

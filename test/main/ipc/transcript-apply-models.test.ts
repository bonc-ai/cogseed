/**
 * transcript.correct.apply × 模型候选（方案 §五 P2-1，与扫描合并后）
 *
 * 三条要钉死的行为：
 *   1. 勾选并应用的模型建议**真的会替换正文**，并作为 source=meeting_accept
 *      记进词表（作用域收窄到当前文档）；
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

const TEXT = '这个方案要付平老师确认一下排期。';
// 付平 在原文里的偏移
const AT = TEXT.indexOf('付平');
const MODEL = { start: AT, wrong: '付平', correct: '傅平', confidence: 0.95, reason: '姓氏同音错写' };

async function apply(payload: Record<string, unknown>) {
  const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
  return (invokeHandlers['transcript.correct.apply'] as (p: unknown, c: unknown) => Promise<any>)(
    { text: TEXT, docId: 'doc_1', ...payload }, ctx(),
  );
}

describe('model_* 候选接入 apply', () => {
  it('勾选的模型建议被替换，并按 meeting_accept 记进词表（仅本文档）', async () => {
    const result = await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    expect(result.result.text).toBe('这个方案要傅平老师确认一下排期。');
    expect(result.result.applied.map((a: any) => a.entryRef)).toContain('model_0');
    expect(result.glossaryWrites).toMatchObject({ created: 1, skipped: 0 });

    const glossary = await import('../../../src/main/features/transcript_glossary');
    const entries = glossary.listEntries(TEST_UID, { status: 'active' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ wrong: '付平', correct: '傅平', source: 'meeting_accept' });
    // 一次会议确认的写法不得升格为全局规则
    expect(entries[0].scope.global).toBe(false);
    expect(entries[0].scope.docIds).toEqual(['doc_1']);
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
    expect(result.result.text).toBe('这个方案要傅平老师确认一下排期。');
    // 只有合法那条进了词表
    expect(result.glossaryWrites).toMatchObject({ created: 1 });
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

  it('已存在同样的词条时是更新而不是重复新增（幂等）', async () => {
    const glossary = await import('../../../src/main/features/transcript_glossary');
    glossary.upsertEntry(TEST_UID, { wrong: '付平', correct: '傅平', source: 'manual', docId: 'doc_1' });
    const result = await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    expect(result.glossaryWrites).toMatchObject({ created: 0, updated: 1 });
    expect(glossary.listEntries(TEST_UID, { status: 'active' })).toHaveLength(1);
  });

  it('应用一次后，词表里就有了这条规则：下次扫描直接命中（D1=B 的意义）', async () => {
    await apply({ models: [MODEL], acceptedIds: ['model_0'] });
    const { invokeHandlers } = await import('../../../src/main/ipc/transcript');
    // 同一份文档：走 docId 作用域
    const scan = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'doc_1' }, ctx());
    expect(scan.candidates.map((c: any) => [c.wrong, c.correct])).toEqual([['付平', '傅平']]);
    // 别的文档不该被这条规则影响
    const other = await (invokeHandlers['transcript.correct.scan'] as any)({ text: TEXT, docId: 'doc_other' }, ctx());
    expect(other.candidates).toEqual([]);
  });
});

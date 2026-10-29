/** 候选 Markdown 方言把换行与制表折叠为单空格，避免多行值被截断或
 * 续行被识别为字段名；正文内容和原 kind 保留。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'reg-b2-flatten';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reg-flatten-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidatesMd(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

async function loadCands() {
  return import('../../src/main/features/personal_ontology_candidates');
}

describe('候选 md 方言拍平序列化（往返不再截断/污染）', () => {
  it('多行 summary/memory_text 往返保全文（换行折叠为空格）', async () => {
    const cands = await loadCands();
    const multiLine = '第一行结论\n第二行证据\t带制表\n\n第三行补充';
    await cands.addCandidate(UID, {
      candidate_id: 'c_multi_1',
      kind: 'preference',
      summary: multiLine,
      memory_text: multiLine,
    });

    const list = await cands.listCandidates(UID);
    const round = list.candidate_updates.find((c) => c.candidate_id === 'c_multi_1');
    expect(round).toBeTruthy();
    // 拍平=有损归一：换行/制表折叠为单空格，但内容不丢、不截断。
    expect(round!.summary).toBe('第一行结论 第二行证据 带制表 第三行补充');
    expect(round!.memory_text).toBe('第一行结论 第二行证据 带制表 第三行补充');
    // 落盘的方言本身是单行：值以拍平后的单行形态出现，盘上不再有多行值。
    const onDisk = fs.readFileSync(candidatesMd(), 'utf8');
    expect(onDisk).toContain('- 摘要: 第一行结论 第二行证据 带制表 第三行补充');
    expect(onDisk).toContain('- 记忆文本: 第一行结论 第二行证据 带制表 第三行补充');
  });

  it('续行形状 `- 类型: rule` 不再覆盖字段（kind 不被污染）', async () => {
    const cands = await loadCands();
    // 旧病灶复现形状：memory_text 内嵌一行「- 类型: rule」续行。
    await cands.addCandidate(UID, {
      candidate_id: 'c_poison_1',
      kind: 'preference',
      summary: '正文第一行\n- 类型: rule\n正文最后一行',
    });

    const list = await cands.listCandidates(UID);
    const round = list.candidate_updates.find((c) => c.candidate_id === 'c_poison_1');
    expect(round).toBeTruthy();
    // kind 保持写入时的 preference，不被续行污染成 rule（落库分档不被改变）。
    expect(round!.kind).toBe('preference');
    // 正文含续行内容（拍平后保留在文本里，而不是截断丢失/顶掉字段）。
    expect(round!.summary).toContain('- 类型: rule');
    expect(round!.summary).toContain('正文最后一行');
  });

  it('拍平只动自由文本，枚举字段原样（对照组）', async () => {
    const cands = await loadCands();
    await cands.addCandidate(UID, {
      candidate_id: 'c_plain_1',
      kind: 'rule',
      confidence: 'high',
      summary: '单行正文',
      memory_text: '单行正文',
      source_memory_refs: ['r1', 'r2'],
    });
    const list = await cands.listCandidates(UID);
    const round = list.candidate_updates.find((c) => c.candidate_id === 'c_plain_1');
    expect(round!.kind).toBe('rule');
    expect(round!.confidence).toBe('high');
    expect(round!.summary).toBe('单行正文');
    expect(round!.source_memory_refs).toEqual(['r1', 'r2']);
  });
});

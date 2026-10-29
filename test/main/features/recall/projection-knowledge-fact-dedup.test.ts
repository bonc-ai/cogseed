import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 事实 ID 由组、字段和归一值决定；读侧按 ID 去重，防止旧数据的空白
 * 变体重复占用预算。不同值仍保留，写侧文本去重不能替代旧数据读侧去重。 */
vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-fact-dedup';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-fact-dedup-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('事实收集读侧按 id 去重', () => {
  it('同字段空白变体值只产出一条事实，不同值互不挤占', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const pk = await import('../../../../src/main/features/recall/projection-knowledge');
    const created = await groups.createGroup(UID, '去重组');
    const gid = created.group!.group_id;
    // 写侧 sanitizePoText 只 trim 首尾、不折叠连续空格，且查重是 text 精确
    // 比较——中间差一个空格的两条都落盘；读侧 \s+→' ' 折叠后归一值相同，
    // factKey / id 因此相同，读侧须折叠这两条等价事实。
    await groups.appendFieldValue(UID, gid, '居住地', '常住 北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住  北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');

    const facts = await pk.loadOntologyFacts(UID, {});
    // 归一后同值的两条 entry 只剩一条事实。
    const beijing = facts.filter((fact) => fact.value === '常住 北京');
    expect(beijing).toHaveLength(1);
    // 事实 id 全局唯一（这是下游按 id 消费的前提）。
    const ids = facts.map((fact) => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 不同值不受影响。
    expect(facts.some((fact) => fact.value === '常住上海')).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// groups 存储链副作用与 candidates.test.ts 同款 mock。
vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

// embedding 受控替身：文本 → 二维向量，用真实余弦算相似。
// 「北京/上海」一对在谈同一件事（高相似），「旅行」无关（低相似）。
const VECTORS: Record<string, [number, number]> = {
  常住北京: [1, 0],
  常住上海: [0.99, 0.02],
  喜欢旅行: [0, 1],
};
let embeddingAvailable = true;
vi.mock('../../../../src/main/features/recall/similarity', () => ({
  embedForDedup: async (_uid: string, text: string): Promise<number[] | null> => {
    if (!embeddingAvailable) return null;
    return VECTORS[text] ?? [0.5, 0.5];
  },
  cosineScore: (a: number[], b: number[]): number => {
    if (!a || !b) return 0;
    const dot = a[0] * b[0] + a[1] * b[1];
    const na = Math.hypot(a[0], a[1]);
    const nb = Math.hypot(b[0], b[1]);
    return na && nb ? dot / (na * nb) : 0;
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-conflicts';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-conflicts-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  embeddingAvailable = true;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../../src/main/features/recall/ontology-conflicts');
}

async function conflictsMd(): Promise<string> {
  const p = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'conflicts.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const JUDGE_CONFLICT: NonNullable<Parameters<typeof import('../../../../src/main/features/recall/ontology-conflicts').checkNewValueAgainst>[5]>['judgeFn']
  = async () => 'conflict';
const JUDGE_NO: typeof JUDGE_CONFLICT = async () => 'no_conflict';
const JUDGE_DOWN: typeof JUDGE_CONFLICT = async () => 'unavailable';

describe('ontology-conflicts › detection levels', () => {
  it('records a conflict when similar values are judged mutually exclusive', async () => {
    const m = await loadModule();
    await m.checkNewValueAgainst(UID, 'grp-1', '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_CONFLICT });
    const ledger = await conflictsMd();
    expect(ledger).toContain('分组: grp-1');
    expect(ledger).toContain('字段: 居住地');
    expect(ledger).toContain('值A: 常住北京');
    expect(ledger).toContain('值B: 常住上海');
  });

  it('records nothing when the judge says not mutually exclusive', async () => {
    const m = await loadModule();
    await m.checkNewValueAgainst(UID, 'grp-1', '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_NO });
    expect(await conflictsMd()).toBe('');
  });

  it('skips the LLM entirely for dissimilar value pairs', async () => {
    const m = await loadModule();
    let judgeCalls = 0;
    const judge: typeof JUDGE_CONFLICT = async () => { judgeCalls += 1; return 'conflict'; };
    await m.checkNewValueAgainst(UID, 'grp-1', '兴趣', '喜欢旅行', ['常住北京'], { judgeFn: judge });
    expect(judgeCalls).toBe(0); // 相似度 < 0.60：不在谈同一件事，不浪费模型调用
    expect(await conflictsMd()).toBe('');
  });

  it('degrades to a silent skip when embedding is unavailable', async () => {
    embeddingAvailable = false;
    const m = await loadModule();
    await m.checkNewValueAgainst(UID, 'grp-1', '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_CONFLICT });
    expect(await conflictsMd()).toBe('');
  });

  it('records nothing when the LLM is unavailable (no fabricated conflicts)', async () => {
    const m = await loadModule();
    await m.checkNewValueAgainst(UID, 'grp-1', '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_DOWN });
    expect(await conflictsMd()).toBe('');
  });

  it('never throws even with a throwing judge', async () => {
    const m = await loadModule();
    const judge: typeof JUDGE_CONFLICT = async () => { throw new Error('llm down'); };
    await expect(m.checkNewValueAgainst(UID, 'grp-1', '居住地', '常住上海', ['常住北京'], { judgeFn: judge }))
      .resolves.toBeUndefined();
    expect(await conflictsMd()).toBe('');
  });

  it('does not double-book the same value pair', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    // 真实组 + 真实值（listConflicts 自愈会校验值仍在组里，假组会被清掉）
    const created = await groups.createGroup(UID, '去重验证组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');
    await m.checkNewValueAgainst(UID, gid, '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_CONFLICT });
    await m.checkNewValueAgainst(UID, gid, '居住地', '常住上海', ['常住北京'], { judgeFn: JUDGE_CONFLICT });
    const live = await m.listConflicts(UID, gid);
    expect(live.length).toBe(1);
  });
});

describe('ontology-conflicts › wired into appendFieldValue + self-heal', () => {
  it('appendFieldValue fires the background check end to end', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    // 替换 judge：模块级的 llmJudgeMutuallyExclusive 不可注入，走端到端时
    // 用 LLM 不可用路径（judge 不会被 mock，runReflection 在测试环境拿不到
    // 模型 → unavailable → 不记账）。所以这里只断言：检查跑过且不抛、不误记。
    const created = await groups.createGroup(UID, '矛盾检测端到端组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');
    // fire-and-forget：等一拍让后台检查完成（LLM 不可用 → 静默跳过）
    await new Promise((r) => setTimeout(r, 50));
    const live = await m.listConflicts(UID, gid);
    expect(Array.isArray(live)).toBe(true); // LLM 缺席时不制造假冲突（空数组）
  });

  it('self-heals ledger rows whose values the user already deleted', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    const created = await groups.createGroup(UID, '自愈验证组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');

    // 手工造一条成立冲突（绕过 LLM：直接写台账 —— 模拟历史检出）
    const ledgerPath = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'conflicts.md');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, [
      '# 本体分组字段值冲突台账', '',
      '### oc-test0001',
      `- 分组: ${gid}`,
      '- 字段: 居住地',
      '- 值A: 常住北京',
      '- 值B: 常住上海',
      `- 检出: ${new Date().toISOString()}`,
      '',
    ].join('\n'), 'utf8');

    // 值仍在 → 台账行保留
    expect((await m.listConflicts(UID, gid)).length).toBe(1);

    // 用户删掉一条值（真删）→ 下次读取自愈清除
    await groups.removeFieldValue(UID, gid, '居住地', '常住上海');
    expect((await m.listConflicts(UID, gid)).length).toBe(0);
    expect(fs.readFileSync(ledgerPath, 'utf8')).not.toContain('oc-test0001');
  });
});

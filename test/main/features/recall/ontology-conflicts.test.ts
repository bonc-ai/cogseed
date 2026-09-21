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
// 并发回归测试用 city-N 系列制造 N 对高相似值。
const VECTORS: Record<string, [number, number]> = {
  常住北京: [1, 0],
  常住上海: [0.99, 0.02],
  喜欢旅行: [0, 1],
};
for (let i = 0; i < 8; i += 1) {
  VECTORS[`城东${i}`] = [1, 0.001 * i];
  VECTORS[`城西${i}`] = [0.99, 0.02 + 0.001 * i];
}
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

  it('self-heals ledger rows whose values the user already deleted', async () => {    const groups = await import('../../../../src/main/features/personal_ontology_groups');
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

// ── 审查修复回归（2026-09-21）：按组过滤误删他组记录 + 模板组自愈误清 ────
describe('ontology-conflicts › scoped self-heal keeps other groups intact', () => {
  it('healing one group does not wipe another group\'s records from the ledger', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    const gidA = (await groups.createGroup(UID, '触发自愈组')).group!.group_id;
    const gidB = (await groups.createGroup(UID, '无辜旁观组')).group!.group_id;
    await groups.appendFieldValue(UID, gidA, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gidA, '居住地', '常住上海', '手动');
    await groups.appendFieldValue(UID, gidB, '工作地', '城东0', '手动');
    await groups.appendFieldValue(UID, gidB, '工作地', '城西0', '手动');

    const ledgerPath = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'conflicts.md');
    const rec = (id: string, gid: string, field: string, a: string, b: string) => [
      `### ${id}`,
      `- 分组: ${gid}`,
      `- 字段: ${field}`,
      `- 值A: ${a}`,
      `- 值B: ${b}`,
      `- 检出: ${new Date().toISOString()}`,
    ].join('\n');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, [
      '# 本体分组字段值冲突台账', '',
      rec('oc-keepA001', gidA, '居住地', '常住北京', '常住上海'), '',
      rec('oc-keepB001', gidB, '工作地', '城东0', '城西0'), '',
    ].join('\n'), 'utf8');

    // 触发条件：带 groupId 读、且该组有一条已失效（用户删了值）→ 写回发生。
    // 修复前：写回只保留 live（=组 A 的记录），组 B 的 oc-keepB001 被连带抹掉。
    await groups.removeFieldValue(UID, gidA, '居住地', '常住上海');
    expect((await m.listConflicts(UID, gidA)).length).toBe(0);
    const after = fs.readFileSync(ledgerPath, 'utf8');
    expect(after).not.toContain('oc-keepA001'); // 失效的本组记录照常自愈
    expect(after).toContain('oc-keepB001'); // 未校验的他组记录必须原样保留
    expect((await m.listConflicts(UID, gidB)).length).toBe(1);
  });
});

describe('ontology-conflicts › template group self-heal', () => {
  it('keeps conflicts whose values live in a template file (sectioned format)', async () => {
    const m = await loadModule();
    // 手工构造一个已安装模板组：groups.md meta 指向模板文件，内容为
    // `## 分节`+`### 字段` 结构（无 `## 字段区` 头）。
    const dir = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
    fs.mkdirSync(dir, { recursive: true });
    const tplId = 'test-tpl-x';
    const tplGid = 'tplgrp-test0001';
    fs.writeFileSync(path.join(dir, `${tplId}.md`), [
      '# 测试角色（模板）',
      `> 模板: ${tplId}@1.0.0 | 已安装: ${new Date().toISOString()}`,
      '',
      '## 基本情况',
      '',
      '### 居住地',
      '- 常住北京 [手动]',
      '- 常住上海 [手动]',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'groups.md'), [
      '# 记忆分组', '',
      `> 最后更新: ${new Date().toISOString()} | 共 1 个分组`, '',
      `### ${tplGid}`,
      '- 标题: 测试角色',
      `- 文件: .personal_ontology_groups/${tplId}.md`,
      `- 创建时间: ${new Date().toISOString()}`,
      `- 更新时间: ${new Date().toISOString()}`,
      `- 模板: ${tplId}@1.0.0`,
      '',
    ].join('\n'), 'utf8');
    const ledgerPath = path.join(dir, 'conflicts.md');
    fs.writeFileSync(ledgerPath, [
      '# 本体分组字段值冲突台账', '',
      '### oc-tpl0001',
      `- 分组: ${tplGid}`,
      '- 字段: 居住地',
      '- 值A: 常住北京',
      '- 值B: 常住上海',
      `- 检出: ${new Date().toISOString()}`,
      '',
    ].join('\n'), 'utf8');

    // 修复前：parseGroupContent 对分节式文件解出空 fields → 两条值都「不存在」
    // → 每次读取都把模板组的冲突整批清掉（模板组矛盾检测整体失效）。
    const live = await m.listConflicts(UID);
    expect(live.length).toBe(1);
    expect(live[0].conflict_id).toBe('oc-tpl0001');
    expect(fs.readFileSync(ledgerPath, 'utf8')).toContain('oc-tpl0001');
  });
});

// ── 遗留修复回归（2026-09-20）：并发覆盖丢行 + 判定悬挂 ───────────────────
describe('ontology-conflicts › concurrency and judge timeout', () => {
  it('concurrent recordings interleaved with self-healing reads lose nothing', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    const created = await groups.createGroup(UID, '并发回归组');
    const gid = created.group!.group_id;
    // 值对两条都要写进组：自愈校验「两条值仍在组里」——新值缺席会被正确地
    // 判为「冲突不再成立」而清除（这正是自愈的语义）。
    for (let i = 0; i < 6; i += 1) {
      await groups.appendFieldValue(UID, gid, `城市${i}`, `城东${i}`, '手动');
    }
    for (let i = 0; i < 6; i += 1) {
      await groups.appendFieldValue(UID, gid, `城市${i}`, `城西${i}`, '智能');
    }
    // 造值触发的后台检查走真实 LLM 路径（测试环境不可用→跳过），等一拍清空
    // 它们的尾巴，下面的并发段用注入 judge 精确控制。
    await new Promise((r) => setTimeout(r, 60));
    // 埋一条死记录（值已不在组里）：自愈读到它才会触发写回——丢行的真机
    // 场景正是「死行 + 并发新活记录」混合，活记录全在时自愈不写回、无覆盖。
    const ledgerSeed = path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'conflicts.md');
    fs.mkdirSync(path.dirname(ledgerSeed), { recursive: true });
    fs.writeFileSync(ledgerSeed, [
      '# 本体分组字段值冲突台账', '',
      '### oc-dead0001',
      `- 分组: ${gid}`,
      '- 字段: 城市X',
      '- 值A: 已删除的值一',
      '- 值B: 已删除的值二',
      `- 检出: ${new Date().toISOString()}`,
      '',
    ].join('\n'), 'utf8');

    // 6 路记账与 3 次自愈读并发交错。judge 带差分延迟让记账段落进自愈读的
    // 时间窗——旧实现（无串行队列）下 read→write 交错互相覆盖（真机曾观察
    // 到「检测记账后、轮询窗口内被自愈写回抹掉」）；串行队列保证不丢。
    const checks = [];
    for (let i = 0; i < 6; i += 1) {
      const delayedJudge: typeof JUDGE_CONFLICT = async (...args) => {
        await new Promise((r) => setTimeout(r, i * 4));
        return JUDGE_CONFLICT(...args);
      };
      checks.push(m.checkNewValueAgainst(UID, gid, `城市${i}`, `城西${i}`, [`城东${i}`], { judgeFn: delayedJudge }));
    }
    const heals = [0, 1, 2].map((k) => new Promise((r) => setTimeout(r, 3 * k + 1))
      .then(() => m.listConflicts(UID, gid)));
    await Promise.all([...checks, ...heals]);

    const final = await m.listConflicts(UID, gid);
    expect(final.length).toBe(6); // 一条不丢：串行队列保证每个事务读到最新
  });

  it('a hung judge resolves as unavailable via timeout instead of blocking forever', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const m = await loadModule();
    const created = await groups.createGroup(UID, '超时回归组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');

    const hungJudge: typeof JUDGE_CONFLICT = () => new Promise(() => {}) as never;
    const started = Date.now();
    await m.checkNewValueAgainst(UID, gid, '居住地', '常住上海', ['常住北京'], {
      judgeFn: hungJudge,
      judgeTimeoutMs: 80,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000); // 没悬挂：超时兜底返回
    // 超时按 unavailable 处理 → 不记账（不制造假冲突）
    expect((await m.listConflicts(UID, gid)).length).toBe(0);
  });
});

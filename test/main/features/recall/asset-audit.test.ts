/**
 * 台账扩展（specs/008 T003/T004）：actor='ai'、before/after、reason、failureCategory。
 *
 * 守两条不变量：
 *   ① FR-004 —— 每次 AI 写操作有台账，四项（actor/时间/前后值/依据）齐全；
 *   ② FR-012 —— 台账只存**摘要**，正文全文不进台账文件。
 *
 * ② 的判据不是"看返回对象"，而是**把 JSONL 原文读出来找关键词**——摘要函数
 * 写错时返回对象仍然好看，只有盘上原文能证伪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-audit-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, store, paths] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/paths'),
  ]);
  return { candidates, assets, store, paths };
}

/** 台账 JSONL 的盘上原文：证明"摘要"是靠读文件，而不是靠信任返回值。 */
async function auditFileText(uid: string, assetId: string): Promise<string> {
  const { paths } = await modules();
  return fs.readFileSync(paths.recallJsonlPath(uid, 'ability-asset-audit', assetId), 'utf8');
}

async function seed(uid: string) {
  const { candidates, assets } = await modules();
  const candidate = await candidates.saveRecallCandidate(uid, {
    judgment: 'Prefer append-only audit trails.',
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: 'Append-only audit habit',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: 'exec-audit' }],
  });
  const asset = (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
  return { assets, asset };
}

describe('台账扩展：actor=ai 与四项齐全（FR-004）', () => {
  it('AI 的写操作留下 actor=ai + 时间 + 前后值 + 依据', async () => {
    const { assets, asset } = await seed('user-ai');
    await assets.updateAbilityAsset('user-ai', asset.id, {
      title: '由 AI 改过的标题',
      statement: 'AI 整理后的正文。',
      reason: '用户要求把这条改清楚点',
      actor: 'ai',
    });

    const row = (await assets.listAbilityAssetAudit('user-ai', asset.id)).at(-1)!;
    expect(row.action).toBe('updated');
    expect(row.actor).toBe('ai');
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    expect(row.reason).toBe('用户要求把这条改清楚点');
    // before/after 是摘要串：至少写明改了哪几维。
    expect(row.before).toContain('title=');
    expect(row.after).toContain('title=由 AI 改过的标题');
    expect(row.before).toContain('statement=');
    // 成功记录不带失败归因。
    expect(row.failureCategory).toBeUndefined();
  });

  it('旧形状的 user 调用不破：note 照旧落盘，reason 同源', async () => {
    const { assets, asset } = await seed('user-compat');
    await assets.pauseAbilityAsset('user-compat', asset.id, { actor: 'user', reason: 'needs review' });

    const row = (await assets.listAbilityAssetAudit('user-compat', asset.id)).at(-1)!;
    // note 是渲染层生命周期记录与 timeline summary 在读的字段，不能消失。
    expect(row.note).toBe('needs review');
    expect(row.reason).toBe('needs review');
    // 状态变更也带前后值：暂停要让用户看见"从哪一档到哪一档"。
    expect(row.before).toContain('status=active');
    expect(row.after).toContain('status=paused');
  });

  it('状态治理动作的前后值覆盖删除与恢复（含保留期计时）', async () => {
    const { assets, asset } = await seed('user-keep');
    await assets.deleteAbilityAsset('user-keep', asset.id, { actor: 'ai', reason: '用户要求删除' });

    const afterDelete = (await assets.listAbilityAssetAudit('user-keep', asset.id)).at(-1)!;
    expect(afterDelete.actor).toBe('ai');
    expect(afterDelete.before).toContain('status=active');
    expect(afterDelete.after).toContain('status=deleted');
    // 保留期计时进入台账：不然"30 天内可恢复"这个承诺无处对账。
    expect(afterDelete.before).toContain('deletedAt=—');
    expect(afterDelete.after).toMatch(/deletedAt=\d{4}-/);

    const restored = await assets.restoreAbilityAsset('user-keep', asset.id, { actor: 'ai', reason: '用户要求恢复' });
    expect(restored.status).toBe('active');
    const afterRestore = (await assets.listAbilityAssetAudit('user-keep', asset.id)).at(-1)!;
    expect(afterRestore.action).toBe('restored');
    expect(afterRestore.before).toMatch(/deletedAt=\d{4}-/);
    expect(afterRestore.after).toContain('deletedAt=—');
  });

  it('非法 actor 仍被拒绝（扩枚举没把闸门放成什么都收）', async () => {
    const { assets, asset } = await seed('user-bad-actor');
    await expect(assets.updateAbilityAsset('user-bad-actor', asset.id, {
      statement: 'nope', reason: 'try', actor: 'robot',
    } as never)).rejects.toThrow(/user actor/i);
  });
});

describe('台账摘要的隐私边界（FR-012）', () => {
  // 正文够长才会被截断，尾部标记用来证明"没把全文抄进台账"。
  const HEAD = '头'.repeat(80);
  const TAIL_MARK = 'TAILMARK-NEVER-IN-LEDGER';
  const BODY = `${HEAD}${TAIL_MARK}`;

  it('正文只留短前缀，全文与尾部都不落台账', async () => {
    const { assets, asset } = await seed('user-l0');
    await assets.updateAbilityAsset('user-l0', asset.id, {
      statement: BODY, reason: '整理正文', actor: 'ai',
    });

    const raw = await auditFileText('user-l0', asset.id);
    expect(raw).not.toContain(TAIL_MARK);
    expect(raw).toContain('头'); // 前缀允许：与详情页对本人可见的信息量一致
    expect(raw).toMatch(/statement=\d+ 字/);
  });
});

describe('摘要函数的边界（纯函数 fixtures）', () => {
  it('空变更集不产出空摘要', async () => {
    const { assets } = await modules();
    expect(assets.summarizeAuditChange([])).toBeUndefined();
    expect(assets.diffAbilityAssetsForAudit({ title: 'same' }, { title: 'same' })).toEqual([]);
  });

  it('只报真正变了的维度，且摘要串有长度上限', async () => {
    const { assets } = await modules();
    const changes = assets.diffAbilityAssetsForAudit(
      { title: '旧', statement: '同', status: 'active' },
      { title: '新', statement: '同', status: 'active' },
    );
    expect(changes.map((change) => change.field)).toEqual(['title']);
    const summary = assets.summarizeAuditChange(
      Array.from({ length: 40 }, (_, index) => ({ field: `f${index}`, before: 'x'.repeat(40), after: 'y'.repeat(40) })),
      'L0',
    )!;
    expect(summary.before.length).toBeLessThanOrEqual(241);
    expect(summary.after.length).toBeLessThanOrEqual(241);
  });
});

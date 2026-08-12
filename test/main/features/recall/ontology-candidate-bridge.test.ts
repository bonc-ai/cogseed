import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-onto-bridge-')); prev = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = prev; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const UID = 'user-bridge';

/** 直接按技能的输出格式写候选台账——不经过 addCandidates，因为技能就是
 *  自己写文件的，bridge 必须能吃它真实产出的形状。 */
function writeLedger(entries: Array<{ id: string; text: string; refs: string[] }>): string {
  const dir = path.join(tmpDir, UID, 'local', 'ontology_candidates');
  fs.mkdirSync(dir, { recursive: true });
  const body = entries.map((e) => [
    `### ${e.id}`,
    '- 类型: preference',
    '- 置信度: low',
    `- 摘要: ${e.text}`,
    '- 去向: user',
    `- 记忆正文: ${e.text}`,
    e.refs.length ? `- 来源: ${e.refs.join(', ')}` : '',
    '',
  ].filter(Boolean).join('\n')).join('\n');
  const file = path.join(dir, 'candidates.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

async function bridge() {
  return import('../../../../src/main/features/recall/ontology-candidate-bridge');
}
async function recall() {
  return import('../../../../src/main/features/recall/candidate-service');
}

describe('本体技能产出 → 统一候选池', () => {
  it('带来源的候选被搬进统一池', async () => {
    writeLedger([{ id: 'oc-1', text: '汇报先给结论再给过程。', refs: ['mem-1'] }]);
    const { syncOntologyCandidatesIntoPool } = await bridge();

    const result = await syncOntologyCandidatesIntoPool(UID);
    expect(result.imported).toBe(1);

    const pool = await (await recall()).listRecallCandidates(UID);
    expect(pool).toHaveLength(1);
    expect(pool[0].judgment).toContain('先给结论');
    // 来源必须跟着进来，否则这条候选在统一池里没法追溯。
    expect(pool[0].sourceRefs.length).toBeGreaterThan(0);
  });

  it('反复同步不会重复生成候选（幂等）', async () => {
    writeLedger([{ id: 'oc-1', text: '汇报先给结论再给过程。', refs: ['mem-1'] }]);
    const { syncOntologyCandidatesIntoPool } = await bridge();

    const first = await syncOntologyCandidatesIntoPool(UID);
    const second = await syncOntologyCandidatesIntoPool(UID);
    const third = await syncOntologyCandidatesIntoPool(UID);

    expect(first.imported).toBe(1);
    // 第二次起指纹命中已有候选，计入 alreadyPresent 而不是再建一条。
    expect(second.imported).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(third.imported).toBe(0);

    const pool = await (await recall()).listRecallCandidates(UID);
    expect(pool).toHaveLength(1);
  });

  it('缺来源的候选被跳过，不给它编造证据', async () => {
    writeLedger([
      { id: 'oc-ok', text: '有来源的判断。', refs: ['mem-1'] },
      { id: 'oc-bare', text: '没有来源的判断。', refs: [] },
    ]);
    const { syncOntologyCandidatesIntoPool } = await bridge();

    const result = await syncOntologyCandidatesIntoPool(UID);
    expect(result.imported).toBe(1);
    expect(result.skippedNoEvidence).toBe(1);

    const pool = await (await recall()).listRecallCandidates(UID);
    expect(pool.map((c) => c.judgment)).toEqual(['有来源的判断。']);
  });

  it('旧台账文件不被删也不被改写', async () => {
    const file = writeLedger([{ id: 'oc-1', text: '要保留的历史候选。', refs: ['mem-1'] }]);
    const before = fs.readFileSync(file, 'utf8');

    const { syncOntologyCandidatesIntoPool } = await bridge();
    await syncOntologyCandidatesIntoPool(UID);
    await syncOntologyCandidatesIntoPool(UID);

    // 搬运是「复制进统一池」，不是「迁走」——兼容来源必须原样可读。
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('台账不存在时安静返回，不报错', async () => {
    // 技能还没跑过是正常状态，不该把认知区搞崩。
    const { syncOntologyCandidatesIntoPool } = await bridge();
    await expect(syncOntologyCandidatesIntoPool(UID)).resolves.toMatchObject({ imported: 0 });
  });
});

describe('统一池的出口：route 只产生一个 canonical 资产', () => {
  it('本体来源的候选 route 之后，资产只有一条', async () => {
    writeLedger([{ id: 'oc-1', text: '汇报先给结论再给过程。', refs: ['mem-1'] }]);
    const { syncOntologyCandidatesIntoPool } = await bridge();
    await syncOntologyCandidatesIntoPool(UID);

    const service = await recall();
    const [candidate] = await service.listRecallCandidates(UID);

    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '工作习惯');

    const route = await import('../../../../src/main/features/kstar/knowledge-route-service');
    const routed = await route.routeConfirmedKstarCandidate(UID, candidate.id, {
      ontology: { groupId: created.group!.group_id },
    });

    // route = promote + 往本体文档追加，不产生第二个资产。
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const all = await assets.listAbilityAssets(UID);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(routed.asset.id);
    // 落点被记进资产，追溯时能说清它去了哪个本体分组。
    expect(routed.asset.ontologyRefs?.[0].groupId).toBe(created.group!.group_id);
  });

  it('非本体候选与本体候选共用同一条候选生命周期', async () => {
    writeLedger([{ id: 'oc-1', text: '来自本体抽取的判断。', refs: ['mem-1'] }]);
    const { syncOntologyCandidatesIntoPool } = await bridge();
    await syncOntologyCandidatesIntoPool(UID);

    const service = await recall();
    // 另一条来自对话侧，直接进同一个池。
    await service.saveRecallCandidate(UID, {
      judgment: '来自对话的判断。',
      suggestedType: 'rule',
      suggestedScope: 'delivery',
      sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
    });

    const pool = await service.listRecallCandidates(UID);
    expect(pool).toHaveLength(2);
    // 关键：两条在同一个列表、同一套状态机里，不是两个池子。
    expect(new Set(pool.map((c) => c.status))).toEqual(new Set(['pending']));

    for (const candidate of pool) await service.promoteRecallCandidate(UID, candidate.id);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.listAbilityAssets(UID)).toHaveLength(2);
  });
});

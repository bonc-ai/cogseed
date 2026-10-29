import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/** 审批与经验合并的半提交恢复：根据版本流补齐审批终态，拒绝已撤回
 * 资产的提议；经验合并中断可幂等续接，已完成 entry 不重复追加。
 * 持久化中间态由夹具构造，不提供绕开产品确认的写入口。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reg-b3-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function approvalModules() {
  const [candidates, assets, approval] = await Promise.all([
    import('../../src/main/features/recall/candidate-service'),
    import('../../src/main/features/recall/asset-service'),
    import('../../src/main/features/recall/asset-approval-service'),
  ]);
  return { candidates, assets, approval };
}

async function seedAsset(uid: string) {
  const { candidates } = await approvalModules();
  const candidate = await createNightlyCandidateFixture(uid, {
    judgment: '回归基线：发布前必须核对回滚方案。',
    summary: 'merge 非原子回归样本',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: `exec-reg-${uid}` }],
  });
  return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
}

describe('审批域', () => {
  const UID = 'reg-b3-approval';

  it('confirm 半提交（资产已改、提议卡 pending）→ 重试按版本流对账补 confirmed，不再死循环', async () => {
    const { assets, approval } = await approvalModules();
    const asset = await seedAsset(UID);
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '生效过一次的正文。' },
      before: 'x', after: 'y', reason: '对账回归',
    });
    // 第一次确认完整成功（资产 v2 + 提议 confirmed）。
    const first = await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm');
    expect(first.ok).toBe(true);
    expect(first.appliedVersion).toBe('2');

    // 模拟半提交：直改盘把提议打回 pending（=「资产已写、状态段没跑」的崩溃残留）。
    const proposalPath = recallJsonRecordPath(UID, 'asset-approvals', proposal.id);
    const raw = JSON.parse(fs.readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(proposalPath, JSON.stringify({ ...raw, state: 'pending' }));

    // 重试确认：对账补 confirmed——不再撞版本冲突死循环，也不重复写资产。
    const retry = await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm');
    expect(retry.ok).toBe(true);
    expect(retry.state).toBe('confirmed');
    expect(retry.appliedVersion).toBe('2');
    const after = await assets.readAbilityAsset(UID, asset.id);
    expect(after.version).toBe('2');
    expect(after.statement).toBe('生效过一次的正文。');
    expect((await approval.readAssetChangeProposal(UID, proposal.id))!.state).toBe('confirmed');
  });

  it('对账不误伤同 id 重提：上一轮确认的旧行 ≤ 本次 baseline，不算半提交残留', async () => {
    const { assets, approval } = await approvalModules();
    const asset = await seedAsset(UID);
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '第一轮提议正文。' },
      before: 'x', after: 'y', reason: '重提对账回归',
    });
    await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm'); // v2
    // 资产又被他处推进到 v3（baseline 随之抬高）。
    await assets.updateAbilityAsset(UID, asset.id, { statement: '他处改过的正文。', reason: 'edit', actor: 'user' });

    // 同一变更重提（dedupe 键相同 → 复用同一提议 id，baseline=v3）。
    const repropose = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: '3',
      fields: ['statement'],
      payload: { statement: '第一轮提议正文。' },
      before: 'x', after: 'y', reason: '重提对账回归',
    });
    expect(repropose.created).toBe(true);
    // 对账不得把上一轮（v2 行，≤ baseline v3）误判成本次半提交而空跳确认：
    // 这次的确认是真正的新写入（v3 → v4）。
    const result = await approval.decideAssetChangeProposal(UID, repropose.proposal.id, 'confirm');
    expect(result.ok).toBe(true);
    expect(result.appliedVersion).toBe('4');
    expect((await assets.readAbilityAsset(UID, asset.id)).statement).toBe('第一轮提议正文。');
  });

  it('后半边：资产被撤回后 confirm 撞终态 → 提议作废（superseded），不再永远 pending', async () => {
    const { assets, approval } = await approvalModules();
    const asset = await seedAsset(UID);
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const { proposal } = await approval.createAssetChangeProposal(UID, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '撤回后的正文。' },
      before: 'x', after: 'y', reason: '撤回作废回归',
    });
    // 窗口期内资产被撤回（直改盘构造，撤回通道同样落这个终态）。
    const assetPath = recallJsonRecordPath(UID, 'ability-assets', asset.id);
    const raw = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(assetPath, JSON.stringify({ ...raw, status: 'revoked' }));

    const result = await approval.decideAssetChangeProposal(UID, proposal.id, 'confirm');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('superseded');
    expect(String(result.message || '')).toContain('撤回');
    expect((await approval.readAssetChangeProposal(UID, proposal.id))!.state).toBe('superseded');
    const rows = await assets.listAbilityAssetAudit(UID, asset.id);
    expect(rows.some((row) => row.action === 'approval_superseded')).toBe(true);
  });
});

describe('经验合并域', () => {
  const UID = 'reg-b3-exp';

  function mkExperience(id: string, title: string) {
    const now = new Date().toISOString();
    return {
      id,
      source: { episodeId: `kse-${id}`, taskGoal: `任务-${id}`, taskType: 'code' as const, taskStatus: 'confirmed' },
      experienceType: 'lesson' as const,
      title,
      body: `${title}：先备份再执行变更。`,
      scope: 'code',
      verification: { state: 'confirmed' as const, outcome: 'met_expected' as const, deltaR: 0.1, confidence: 0.7 },
      evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${id}` }],
      learningProvenance: { projectionId: `prj-${id}`, episodeId: `kse-${id}`, ruleRefs: [], attribution: 'execution_gap' as const },
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function setup() {
    const users = await import('../../src/main/features/users');
    users.activateUser(UID);
    const svc = await import('../../src/main/features/recall/experience-service');
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    return { svc, recallJsonRecordPath };
  }

  function readRaw(recallJsonRecordPath: (uid: string, c: string, id: string) => string, id: string) {
    return JSON.parse(fs.readFileSync(recallJsonRecordPath(UID, 'experiences', id), 'utf8')) as Record<string, unknown>;
  }

  function writeRaw(recallJsonRecordPath: (uid: string, c: string, id: string) => string, id: string, record: Record<string, unknown>) {
    fs.writeFileSync(recallJsonRecordPath(UID, 'experiences', id), JSON.stringify(record));
  }

  /** 中断残留构造：target 已带 interrupted entry（=①段落盘后②段失败）。 */
  function seedInterruptedResidue(
    recallJsonRecordPath: (uid: string, c: string, id: string) => string,
    sourceId: string,
    targetId: string,
  ) {
    const tgt = readRaw(recallJsonRecordPath, targetId);
    const now = new Date().toISOString();
    writeRaw(recallJsonRecordPath, targetId, {
      ...tgt,
      mergedFrom: [...((tgt.mergedFrom as unknown[]) || []), { id: sourceId, title: '中断源', mergedAt: now, interrupted: true }],
      history: [...((tgt.history as unknown[]) || []), { at: now, actor: 'user', action: 'merged_from', from: sourceId, interrupted: true }],
      updatedAt: now,
    });
  }

  it('幂等重试：中断残留（source 仍 active）重试可收口——entry 不重复、interrupted 清除、source 置 merged', async () => {
    const { svc, recallJsonRecordPath } = await setup();
    await svc.createExperience(UID, mkExperience('exp-reg-src', '中断源'));
    await svc.createExperience(UID, mkExperience('exp-reg-tgt', '中断靶'));
    seedInterruptedResidue(recallJsonRecordPath, 'exp-reg-src', 'exp-reg-tgt');

    const merged = await svc.mergeExperiences(UID, 'exp-reg-src', 'exp-reg-tgt', '重试收口');
    expect(merged.source.status).toBe('merged');
    expect(merged.source.mergedIntoExperienceId).toBe('exp-reg-tgt');

    const tgt = readRaw(recallJsonRecordPath, 'exp-reg-tgt');
    const entries = (tgt.mergedFrom as Array<{ id: string; interrupted?: boolean }>).filter((e) => e.id === 'exp-reg-src');
    expect(entries).toHaveLength(1); // 不叠重复条目
    expect(entries[0].interrupted).toBeUndefined(); // 收口清除标志
    const history = tgt.history as Array<{ action: string; from?: string; interrupted?: boolean }>;
    const rows = history.filter((h) => h.action === 'merged_from' && h.from === 'exp-reg-src');
    expect(rows).toHaveLength(1); // 台账也只有一条（重试不追加）
    expect(rows[0].interrupted).toBeUndefined();
  });

  it('入口对账：source 已 merged 指向本 target 且残留 interrupted → 重试自愈收口，不死在 already-merged', async () => {
    const { svc, recallJsonRecordPath } = await setup();
    await svc.createExperience(UID, mkExperience('exp-reg2-src', '崩溃源'));
    await svc.createExperience(UID, mkExperience('exp-reg2-tgt', '崩溃靶'));
    seedInterruptedResidue(recallJsonRecordPath, 'exp-reg2-src', 'exp-reg2-tgt');
    // ②段成功但③收口没跑（崩溃残留）：source 置 merged 指向 target。
    const src = readRaw(recallJsonRecordPath, 'exp-reg2-src');
    writeRaw(recallJsonRecordPath, 'exp-reg2-src', {
      ...src,
      status: 'merged',
      mergedIntoExperienceId: 'exp-reg2-tgt',
      updatedAt: new Date().toISOString(),
    });

    // 重试：入口对账先收口（清 interrupted）再返回成功，不抛 already-merged。
    const result = await svc.mergeExperiences(UID, 'exp-reg2-src', 'exp-reg2-tgt');
    expect(result.source.status).toBe('merged');
    const tgt = readRaw(recallJsonRecordPath, 'exp-reg2-tgt');
    const entries = (tgt.mergedFrom as Array<{ id: string; interrupted?: boolean }>).filter((e) => e.id === 'exp-reg2-src');
    expect(entries).toHaveLength(1);
    expect(entries[0].interrupted).toBeUndefined();
  });

  it('台账查重：target 已有完整（无 interrupted）的同源 entry → 再合并抛错，不叠第二条', async () => {
    const { svc, recallJsonRecordPath } = await setup();
    await svc.createExperience(UID, mkExperience('exp-reg3-src', '完整源'));
    await svc.createExperience(UID, mkExperience('exp-reg3-tgt', '完整靶'));
    // 先完整合并一次。
    await svc.mergeExperiences(UID, 'exp-reg3-src', 'exp-reg3-tgt');
    // 窗口态构造：source 被外部改回 active（终态守卫被绕过的持久化假象），
    // target 侧留着完整 entry——此时再合并必须被锁内查重拦下。
    const src = readRaw(recallJsonRecordPath, 'exp-reg3-src');
    const { mergedIntoExperienceId: _dropped, ...srcRest } = src;
    writeRaw(recallJsonRecordPath, 'exp-reg3-src', { ...srcRest, status: 'active', updatedAt: new Date().toISOString() });

    await expect(svc.mergeExperiences(UID, 'exp-reg3-src', 'exp-reg3-tgt')).rejects.toThrow(/already been merged into exp-reg3-tgt/);
    const tgt = readRaw(recallJsonRecordPath, 'exp-reg3-tgt');
    const entries = (tgt.mergedFrom as Array<{ id: string }>).filter((e) => e.id === 'exp-reg3-src');
    expect(entries).toHaveLength(1); // 查重抛错，不产生第二条影子条目
  });
});

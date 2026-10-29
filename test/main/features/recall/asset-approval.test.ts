import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
/**
 * 资产修改审批提议。
 *
 * 守四条：
 *   ① 实质变化**零静默发布**：`pending`/`deferred` 期间资产内容与版本分毫不动；
 *   ② 确认时**版本重检**：资产已被改过 → 提议作废，不覆盖现有内容；
 *   ③ `defer` 进待确认清单不丢；`reject` 留档且同变更不再重复提交；
 *   ④ 卡片是提议不是锁：有待处理卡片不阻塞资产正常使用。
 *
 * 卡片下发走 `port` 注入（与 KSTAR 复盘卡同款），所以这里用假 port 验载荷，
 * 不必拉起整条 group_chat。
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-approval-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, approval, card, inbox, adapter] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/asset-approval-service'),
    import('../../../../src/main/features/recall/asset-approval-card'),
    import('../../../../src/main/features/recall/formal-assets/inbox'),
    import('../../../../src/main/features/cognition/inbox-adapter'),
  ]);
  return { candidates, assets, approval, card, inbox, adapter };
}

async function seedAsset(uid: string, judgment = '发布前必须核对回滚方案。') {
  const { candidates } = await modules();
  const candidate = await createNightlyCandidateFixture(uid, {
    judgment,
    // 标题闸门：无 summary 兜底＝正文首句，过不了闸门。
    summary: '审批基线样本',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: 'exec-approval' }],
  });
  return (await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' })).asset;
}

async function proposeStatementChange(uid: string, assetId: string, baselineVersion: string, statement: string) {
  const { approval } = await modules();
  return approval.createAssetChangeProposal(uid, {
    assetId,
    baselineVersion,
    fields: ['statement'],
    payload: { statement },
    before: 'statement=12 字',
    after: `statement=${statement.length} 字`,
    reason: 'AI 依据：同类任务的实际结果提示这句话该更具体',
  });
}

describe('提议实体与状态机', () => {
  it('建提议不改资产：pending 期间内容与版本分毫不动，也不阻塞正常使用', async () => {
    const uid = 'user-propose';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal, created } = await proposeStatementChange(uid, asset.id, asset.version, '更具体的正文。');
    expect(created).toBe(true);
    expect(proposal.state).toBe('pending');

    const after = await assets.readAbilityAsset(uid, asset.id);
    expect(after.statement).toBe(asset.statement);
    expect(after.version).toBe(asset.version);
    expect(after.status).toBe('active');
    // 提议不是锁：资产照常可用（还在 active、还在清单里）。
    const listed = await assets.listAbilityAssets(uid);
    expect(listed.some((row) => row.id === asset.id && row.status === 'active')).toBe(true);
    // 提案本身进台账（AI 提出这件事也要留痕）。
    const rows = await assets.listAbilityAssetAudit(uid, asset.id);
    const proposed = rows.find((row) => row.action === 'approval_proposed')!;
    expect(proposed.actor).toBe('ai');
    expect(String(proposed.note)).toContain(proposal.id);
  });

  it('同一变更不重复提交（去重），字段顺序不同也算同一次', async () => {
    const uid = 'user-dedupe';
    const { approval } = await modules();
    const asset = await seedAsset(uid);
    const first = await proposeStatementChange(uid, asset.id, asset.version, '同一个正文。');
    expect(first.created).toBe(true);
    const again = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '同一个正文。' },
      before: 'x', after: 'y', reason: '再来一次',
    });
    expect(again.created).toBe(false);
    expect(again.proposal.id).toBe(first.proposal.id);
  });

  it('字段集不同 = 另一次变更，不去重', async () => {
    const uid = 'user-dedupe-fields';
    const { approval } = await modules();
    const asset = await seedAsset(uid);
    const first = await proposeStatementChange(uid, asset.id, asset.version, '同一个正文。');
    const wider = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement', 'scope'],
      payload: { statement: '同一个正文。', scope: 'review' },
      before: 'x', after: 'y', reason: '连范围一起改',
    });
    expect(wider.created).toBe(true);
    expect(wider.proposal.id).not.toBe(first.proposal.id);
  });
});

describe('三态处置', () => {
  it('确认更新：按确认内容生效 + 台账两行（AI 提出 / 用户确认）', async () => {
    const uid = 'user-confirm';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '确认后生效的正文。');

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('confirmed');
    const after = await assets.readAbilityAsset(uid, asset.id);
    expect(after.statement).toBe('确认后生效的正文。');
    expect(after.version).not.toBe(asset.version);

    const rows = await assets.listAbilityAssetAudit(uid, asset.id);
    // 生效那一行 actor=user：是用户点了"确认更新"才落地的，不是 AI 自己动的手。
    const updated = rows.find((row) => row.action === 'updated')!;
    expect(updated.actor).toBe('user');
    expect(String(updated.reason)).toContain(proposal.id);
    expect(rows.some((row) => row.action === 'approval_confirmed' && row.actor === 'user')).toBe(true);
    // AI 的作者身份留在提议那一行。
    expect(rows.find((row) => row.action === 'approval_proposed')!.actor).toBe('ai');
  });

  it('确认时版本重检不一致：冲突即作废——提议置 superseded，不静默覆盖', async () => {
    const uid = 'user-conflict';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, 'AI 想改成的正文。');
    // 用户（或别处）先改了这条资产。
    await assets.updateAbilityAsset(uid, asset.id, { statement: '用户自己改过的正文。', reason: 'user edit', actor: 'user' });

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('superseded');
    expect(result.versionConflict).toMatchObject({ baselineVersion: '1' });
    // 资产保持用户改后的内容，AI 的提议没有被套上去。
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('用户自己改过的正文。');
    // 冲突即作废：baseline 永不刷新，confirm 对这条提议永久不可达——作废后
    // AI 可基于最新版本重提（作废态不进去重拦截）。
    expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe('superseded');
    const rows = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(String(rows.find((row) => row.action === 'approval_superseded')?.note)).toContain(proposal.id);
    // 作废不挡重提：同一变更可以再提（新提议、新 baseline）。
    const repropose = await proposeStatementChange(uid, asset.id, '2', 'AI 想改成的正文。');
    expect(repropose.created).toBe(true);
  });

  // 标签更新不 bump 内容版本：expectedVersion 看不见期间的手动打标，
  // 所以门禁必须按"提议时的标签集合"再做一次写锁内 CAS。
  it('标签在提议后被改过：确认作废，不整组覆盖期间的新标签', async () => {
    const uid = 'user-tag-conflict';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    expect(asset.tags || []).toEqual([]);
    const { proposal } = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['tags'],
      payload: { tags: ['模板'] },
      beforeValues: { tags: [] },
      before: 'tags=0', after: 'tags=1',
      reason: '把这条资产归到模板组',
    });
    await assets.updateAbilityAsset(uid, asset.id, { tags: ['重要'], reason: 'user tag edit', actor: 'user' });
    expect((await assets.readAbilityAsset(uid, asset.id)).version).toBe(asset.version);

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('superseded');
    expect(result.tagConflict).toMatchObject({ baselineTags: [], currentTags: ['重要'] });
    expect((await assets.readAbilityAsset(uid, asset.id)).tags).toEqual(['重要']);
    expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe('superseded');
    const rows = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(String(rows.find((row) => row.action === 'approval_superseded')?.note)).toContain(proposal.id);
  });

  it('标签未变时确认成功，且标签更新不 bump 内容版本', async () => {
    const uid = 'user-tag-confirm';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['tags'],
      payload: { tags: ['模板'] },
      beforeValues: { tags: [] },
      before: 'tags=0', after: 'tags=1', reason: '打标',
    });
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(true);
    const after = await assets.readAbilityAsset(uid, asset.id);
    expect(after.tags).toEqual(['模板']);
    expect(after.version).toBe(asset.version);
  });

  it('标签顺序/大小写不同但集合一致：不算冲突', async () => {
    const uid = 'user-tag-order';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    await assets.updateAbilityAsset(uid, asset.id, { tags: ['Alpha', 'Beta'], reason: 'seed tags', actor: 'user' });
    const tagged = await assets.readAbilityAsset(uid, asset.id);
    const { proposal } = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: tagged.version,
      fields: ['tags'],
      payload: { tags: ['Beta', 'Alpha', 'Gamma'] },
      beforeValues: { tags: ['Alpha', 'Beta'] },
      before: 'tags=2', after: 'tags=3', reason: '加一个标签',
    });
    await assets.updateAbilityAsset(uid, asset.id, { tags: ['beta', 'alpha'], reason: 'reorder', actor: 'user' });
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(true);
    expect((await assets.readAbilityAsset(uid, asset.id)).tags).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  /** decide 的 payload 此前整对象直达资产更新，治理键（actor/
   *  reason/expectedVersion/id）混入即被写路径消费。修复：键集白名单过滤，
   *  只放行内容字段；治理键由 decide 自己显式设置。 */
  it('confirm 带毒键 payload——治理键被键集过滤丢弃，只生效内容字段', async () => {
    const uid = 'user-payload-keys';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '想生效的正文。');

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm', {
      payload: {
        statement: '确认时用户编辑过的正文。',
        actor: 'ai' as never,                       // 毒键：生效 actor 必须仍是 user
        reason: '被 payload 覆盖的 reason' as never, // 毒键：reason 必须是 decide 的
        expectedVersion: '99' as never,             // 毒键：不得借 payload 抢 CAS 位
        id: 'aa-forged' as never,                   // 毒键：身份不可变
        ownerId: 'someone-else' as never,           // 毒键
        statementLengthHack: 1 as never,            // 未知键不落盘
      },
    });
    expect(result.ok).toBe(true);
    const after = await assets.readAbilityAsset(uid, asset.id);
    expect(after.statement).toBe('确认时用户编辑过的正文。');
    expect(after.id).toBe(asset.id);
    expect(after.ownerId).toBe(uid);
    // 生效 actor 是用户（decide 显式设置），不是 payload 塞进来的 ai。
    const rows = await assets.listAbilityAssetAudit(uid, asset.id);
    expect(rows.find((row) => row.action === 'updated')!.actor).toBe('user');
    expect(String(rows.find((row) => row.action === 'updated')!.reason)).toContain(proposal.id);
  });

  it('稍后处理：进待确认清单，不丢', async () => {
    const uid = 'user-defer';
    const { assets, approval, inbox, adapter } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '稍后再说。');

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'defer');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('deferred');
    // 内容照旧没变。
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe(asset.statement);

    // 纯函数层：待处理/稍后的提议都进清单（"稍后不丢"就靠这条）。
    const items = inbox.buildCognitionInbox({
      assets: [], candidates: [], unavailableSourceIds: new Set(),
      pendingAssetChanges: [{ proposalId: proposal.id, assetId: asset.id, title: asset.title }],
    });
    const entry = items.find((row) => row.kind === 'asset_change_pending')!;
    expect(entry.id).toBe(`proposal:${proposal.id}`);
    expect(entry.urgency).toBe('confirm');
    expect(entry.assetId).toBe(asset.id);

    // 处置通道：清单里的这条能直接确认。
    const resolved = await adapter.resolveCognitionInboxItem(uid, { id: `proposal:${proposal.id}`, action: 'accept' });
    expect(resolved).toMatchObject({ ok: true, target: 'asset_change_proposal', status: 'confirmed' });
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('稍后再说。');
  });

  it('拒绝：留档 + 同一变更不再重复提交', async () => {
    const uid = 'user-reject';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '会被拒的正文。');

    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'reject');
    expect(result.ok).toBe(true);
    expect(result.state).toBe('rejected');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe(asset.statement);
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).some((row) => row.action === 'approval_rejected')).toBe(true);

    // 同一变更再来一次：不再生成新卡片。
    const again = await proposeStatementChange(uid, asset.id, asset.version, '会被拒的正文。');
    expect(again.created).toBe(false);
    expect(again.proposal.state).toBe('rejected');
    // 已处置过的提议不能再被处置一次。
    expect((await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm')).ok).toBe(false);
  });

  it('用户编辑卡片内容：按编辑后的内容生效，编辑本身进台账', async () => {
    const uid = 'user-edit-card';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, 'AI 原来的写法。');

    const edited = await approval.editAssetChangeProposal(uid, proposal.id, { statement: '用户改过的写法。' });
    expect(edited.payload.statement).toBe('用户改过的写法。');
    expect(edited.state).toBe('pending');
    const rowsAfterEdit = await assets.listAbilityAssetAudit(uid, asset.id);
    const editRow = rowsAfterEdit.find((row) => row.action === 'approval_edited')!;
    expect(editRow.actor).toBe('user');
    // 编辑不改资产（还没确认）。
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe(asset.statement);

    await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('用户改过的写法。');
  });
});

describe('审批与资产版本语义一致', () => {
  it('确认前 v1 不变；确认后形成 v2，历史引用仍读 v1、新任务读 v2', async () => {
    const uid = 'user-version-semantics';
    const { assets, approval } = await modules();
    const asset = await seedAsset(uid);
    const v1Statement = asset.statement;
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '确认后的第二版正文。');

    // 确认前：v1 不变。
    const beforeConfirm = await assets.readAbilityAsset(uid, asset.id);
    expect(beforeConfirm.version).toBe('1');
    expect(beforeConfirm.statement).toBe(v1Statement);

    await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    const after = await assets.readAbilityAsset(uid, asset.id);
    // 确认后：同一资产形成 v2（内容是新版）。
    expect(after.version).toBe('2');
    expect(after.activeVersion).toBe('2');
    expect(after.statement).toBe('确认后的第二版正文。');
    // 历史引用仍读 v1：已冻结版本的内容快照原样在，没被这次更新改写。
    const v1Snapshot = await assets.readAbilityAssetVersionSnapshot(uid, asset.id, '1');
    expect(v1Snapshot?.statement).toBe(v1Statement);
    // 版本链完整可溯（v1 与 v2 都在）。
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((row) => row.version)).toEqual(['1', '2']);
  });

  it('稍后处理与拒绝都保持 v1 不变且提议留档（"保持原版"= 拒绝）', async () => {
    const uid = 'user-keep-v1';
    const { assets, approval } = await modules();
    // 两条基线必须彼此不同：晋升通道有相似度闸门（近重复候选会被正当拦下）。
    const baselines = {
      defer: '把长会议压成三条可执行结论。',
      reject: '导出报表一律带上生成时间戳。',
    } as const;
    for (const decision of ['defer', 'reject'] as const) {
      const asset = await seedAsset(uid, baselines[decision]);
      const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '不该生效的正文。');
      const result = await approval.decideAssetChangeProposal(uid, proposal.id, decision);
      expect(result.state, decision).toBe(decision === 'defer' ? 'deferred' : 'rejected');
      const after = await assets.readAbilityAsset(uid, asset.id);
      expect(after.version, decision).toBe('1');
      expect(after.statement, decision).toBe(asset.statement);
      // 提议留档（不丢）。
      expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe(result.state);
    }
  });
});

describe('卡片载荷与下发', () => {
  it('载荷形状与契约一致：kind/proposalId/diff/reason/三操作', async () => {
    const uid = 'user-card';
    const { approval, card } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '卡片载荷。');

    const payload = card.buildAssetChangeApprovalCard(proposal, asset.title);
    expect(payload.kind).toBe('asset_change_approval');
    expect(payload.proposalId).toBe(proposal.id);
    expect(payload.assetId).toBe(asset.id);
    expect(payload.assetTitle).toBe(asset.title);
    expect(payload.baselineVersion).toBe('1');
    expect(payload.diff).toMatchObject({ fields: ['statement'] });
    expect(payload.diff.before).toContain('statement=');
    expect(payload.reason).toContain('同类任务的实际结果');
    // 按钮名与已定口径一致（不用"立即采用"）。
    expect(payload.actions).toEqual(['confirm', 'defer', 'reject']);
  });

  it('提议带上「当前值」：卡片要能让用户对比"当前 → 拟生效"', async () => {
    const uid = 'user-card-current';
    const { approval, assets } = await modules();
    const asset = await seedAsset(uid, '当前的正文内容。');
    // 与工具层同款：把要改的字段**当前值**一并带上。
    const { proposal } = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['statement'],
      payload: { statement: '拟生效的新正文。' },
      beforeValues: { statement: asset.statement },
      before: 'statement=7 字',
      after: 'statement=8 字',
      reason: 'AI 依据：句子可以更具体',
    });
    const stored = await approval.readAssetChangeProposal(uid, proposal.id);
    expect(stored!.beforeValues).toEqual({ statement: '当前的正文内容。' });
    expect(stored!.payload).toEqual({ statement: '拟生效的新正文。' });
    // 提议仍然不动资产。
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('当前的正文内容。');
    // 老提议（没有 beforeValues）也读得出来——卡片对这类如实降级。
    const legacy = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id,
      baselineVersion: asset.version,
      fields: ['scope'],
      payload: { scope: 'review' },
      before: 'x', after: 'y', reason: '演示老提议',
    });
    expect((await approval.readAssetChangeProposal(uid, legacy.proposal.id))!.beforeValues).toBeUndefined();
  });

  it('下发走注入的 port，文案带资产名与依据', async () => {
    const uid = 'user-card-port';
    const { approval, card } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '下发测试。');
    const sent: Array<{ cid: string; text: string; kind: string }> = [];
    const posted = await card.postAssetChangeApprovalCard(uid, 'conv-1', proposal, asset.title, {
      send: async (payload) => {
        sent.push({ cid: payload.cid, text: payload.text, kind: payload.asset_change_approval_card.kind });
        return { id: 'msg-1' };
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ cid: 'conv-1', kind: 'asset_change_approval' });
    expect(sent[0].text).toContain(asset.title);
    expect(sent[0].text).toContain('同类任务的实际结果');
    expect(posted.msg.id).toBe('msg-1');
  });

  it('回填卡片消息 id，供回执定位', async () => {
    const uid = 'user-card-attach';
    const { approval } = await modules();
    const asset = await seedAsset(uid);
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '回填测试。');
    await approval.attachAssetChangeProposalCard(uid, proposal.id, 'msg-9');
    expect((await approval.readAssetChangeProposal(uid, proposal.id))!.cardMessageId).toBe('msg-9');
  });
});

/**
 * 审批与候选共用写通道、版本语义和处置状态：
 *   · 版本冲突结构字段名一致（候选侧只多一个本链路的 targetVersionUsed）；
 *   · 处置三态用同一套状态词（confirmed / deferred / rejected）；
 *   · 「拒绝 = 保持原版 + 留档」两侧一致；
 *   · 两条线共用锁内版本比对。
 */
describe('审批与候选的写入约束一致', () => {
  it('版本冲突结构字段名一致：候选侧 = 008 侧 + targetVersionUsed', async () => {
    const uid = 'user-parity-conflict';
    const { assets, approval, candidates } = await modules();
    const asset = await seedAsset(uid, '冲突口径的基线正文。');

    // 008 侧：提议基于 v1 → 资产被他处改到 v2 → 确认 → 结构化冲突。
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, 'AI 想改成的正文。');
    await assets.updateAbilityAsset(uid, asset.id, { statement: '他处改过的正文一。', reason: 'elsewhere', actor: 'user' });
    const eight = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(eight.ok).toBe(false);
    expect(eight.versionConflict).toEqual({ baselineVersion: '1', currentVersion: '2' });

    // 候选侧：更新型候选锚定 v2 → 资产再被改到 v3 → 确认 → 结构化冲突。
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '候选想改成的新正文。', summary: '改文候选样本',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      suggestedAction: 'limit_scope',
      targetAssetId: asset.id,
      targetVersionUsed: '2',
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-parity-conflict' }],
    });
    await assets.updateAbilityAsset(uid, asset.id, { statement: '他处改过的正文二。', reason: 'elsewhere again', actor: 'user' });
    let candidateConflict: { versionConflict?: Record<string, unknown> } | undefined;
    try {
      await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
      throw new Error('expected a structured version conflict');
    } catch (error) {
      candidateConflict = error as { versionConflict?: Record<string, unknown> };
    }
    expect(candidateConflict!.versionConflict).toEqual({ baselineVersion: '2', currentVersion: '3', targetVersionUsed: '2' });

    // 字段名一致：008 侧的键从**真实返回体**里取，候选侧只多一个 targetVersionUsed。
    const eightConflict = eight.versionConflict as Record<string, unknown>;
    const eightKeys = Object.keys(eightConflict);
    expect(Object.keys(candidateConflict!.versionConflict!)).toEqual([...eightKeys, 'targetVersionUsed']);
    // 共享字段连类型也一致（都是版本号字符串）。
    for (const key of eightKeys) {
      expect(typeof eightConflict[key], `008 ${key}`).toBe('string');
      expect(typeof candidateConflict!.versionConflict![key], `候选 ${key}`).toBe('string');
    }
    // 两侧冲突后各有去处：审批提议冲突即作废（baseline 永不刷新，
    // 死路不如作废，AI 会重提），候选保持待处理（候选重检锚定最新版本，可再决定）。
    expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe('superseded');
    expect((await candidates.readRecallCandidate(uid, candidate.id)).status).toBe('pending_review');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('他处改过的正文二。');
  });

  it('状态词一致：提议三态（confirmed/deferred/rejected），候选两态（confirmed/rejected，deferred 已成系统专用 2026-10-02）', async () => {
    const uid = 'user-parity-tri-state';
    const { approval, candidates } = await modules();
    const asset = await seedAsset(uid, '三态口径的基线正文。');

    // 008 侧：同一条资产上的三次提议（正文各不相同，避免被去重合并）。
    const eightStates: string[] = [];
    for (const [decision, statement] of [
      ['confirm', '008 确认态正文。'],
      ['defer', '008 稍后态正文。'],
      ['reject', '008 拒绝态正文。'],
    ] as const) {
      const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, statement);
      const result = await approval.decideAssetChangeProposal(uid, proposal.id, decision);
      expect(result.ok, decision).toBe(true);
      eightStates.push(String(result.state));
    }

    // 候选侧：同一条资产上的三条候选（一条确认、一条稍后、一条拒绝）。
    const saveCandidate = (judgment: string, sourceId: string) => createNightlyCandidateFixture(uid, {
      judgment,
      summary: '三态对齐样本',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      suggestedAction: 'limit_scope',
      targetAssetId: asset.id,
      sourceRefs: [{ kind: 'execution_evaluation', id: sourceId }],
    });
    const confirmed = await saveCandidate('候选确认态正文。', 'run-parity-confirm');
    const rejected = await saveCandidate('候选拒绝态正文。', 'run-parity-reject');
    const candidateStates = [
      (await candidates.promoteRecallCandidate(uid, confirmed.id, { actor: 'user' })).candidate.status,
      (await candidates.rejectRecallCandidate(uid, rejected.id)).status,
    ];

    // 用户可达的状态词对齐：候选侧 confirmed/rejected 与提议侧同名；
    // 提议侧多出的 deferred 是其独有的「稍后处理」（候选侧已删，2026-10-02）。
    expect(candidateStates).toEqual(['confirmed', 'rejected']);
    expect(eightStates.filter((state) => state !== 'deferred')).toEqual(candidateStates);
  });

  it('「拒绝 = 保持原版 + 留档」两侧一致', async () => {
    const uid = 'user-parity-keep-original';
    const { assets, approval, candidates } = await modules();
    const decisions = await import('../../../../src/main/features/cognition/review-decision');
    const asset = await seedAsset(uid, '拒绝口径的基线正文。');

    // 008 侧：拒绝 → 内容/版本不动，提议留档，审计有 approval_rejected。
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '不该生效的正文（008）。');
    const eight = await approval.decideAssetChangeProposal(uid, proposal.id, 'reject');
    expect(eight.state).toBe('rejected');
    expect((await assets.readAbilityAsset(uid, asset.id))).toMatchObject({ version: asset.version, statement: asset.statement });
    expect((await assets.listAbilityAssetAudit(uid, asset.id)).some((row) => row.action === 'approval_rejected')).toBe(true);
    expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe('rejected');

    // 候选侧：拒绝 → 同一个含义（保持原版）+ 留档（决定账本）。
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '不该生效的正文（候选）。', summary: '保持原版用例',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      suggestedAction: 'limit_scope',
      targetAssetId: asset.id,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-parity-reject' }],
    });
    const kept = await candidates.rejectRecallCandidate(uid, candidate.id, '保持原版');
    expect(kept.status).toBe('rejected');
    expect((await assets.readAbilityAsset(uid, asset.id))).toMatchObject({ version: asset.version, statement: asset.statement });
    const ledger = await decisions.listReviewDecisions(uid, `recall_candidate:${candidate.id}`);
    expect(ledger.find((row) => row.decision_type === 'reject')!.reason).toBe('保持原版');
    expect((await candidates.readRecallCandidate(uid, candidate.id)).status).toBe('rejected');
  });

  it('008 重检不回退，且两条线共用同一处锁内比对：同一资产的并发确认只有一个生效', async () => {
    const uid = 'user-parity-one-lock';
    const { assets, approval, candidates } = await modules();
    const asset = await seedAsset(uid, '并发口径的基线正文。');
    const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '008 并发想改成的正文。');
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '候选并发想改成的正文。', summary: '并发改文用例',
      suggestedType: 'rule',
      ...RULE_BOUNDARY,
      suggestedScope: 'architecture',
      suggestedAction: 'limit_scope',
      targetAssetId: asset.id,
      targetVersionUsed: asset.version,
      sourceRefs: [{ kind: 'execution_evaluation', id: 'run-parity-one-lock' }],
    });

    const [eight, six] = await Promise.allSettled([
      approval.decideAssetChangeProposal(uid, proposal.id, 'confirm'),
      candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' }),
    ]);

    const applied: string[] = [];
    if (eight.status === 'fulfilled' && (eight.value as { ok: boolean }).ok) applied.push('008');
    if (six.status === 'fulfilled') applied.push('candidate');
    // 只有一条线真的写进去了（比对在 updateAbilityAsset 锁内，后到的那条必然撞版本）。
    expect(applied).toHaveLength(1);
    expect((await assets.readAbilityAsset(uid, asset.id)).version).toBe('2');
    expect((await assets.listAbilityAssetVersions(uid, asset.id)).map((row) => row.version)).toEqual(['1', '2']);
    // 输的那条是**结构化**冲突（不是被吞掉），字段名与赢家无关、两条线一致。
    const loserConflict = applied[0] === '008'
      ? (six as PromiseRejectedResult).reason.versionConflict
      : (eight as PromiseFulfilledResult<{ versionConflict?: unknown }>).value.versionConflict;
    expect(loserConflict).toMatchObject({ baselineVersion: '1', currentVersion: '2' });
    // 候选保持待处理；审批提议冲突即作废
    // （confirm 对旧 baseline 永久不可达，作废让位于 AI 的重提）。
    if (applied[0] === '008') {
      expect((await candidates.readRecallCandidate(uid, candidate.id)).status).toBe('pending_review');
    } else {
      expect((await approval.readAssetChangeProposal(uid, proposal.id))!.state).toBe('superseded');
    }
  });
});

describe('future use content round trip', () => {
  it('preserves the candidate future use and confirms a value-only proposal as a new version', async () => {
    const uid = 'synthetic-future-use';
    const { candidates, assets, approval } = await modules();
    const candidate = await createNightlyCandidateFixture(uid, {
      summary: '来源核对规则', judgment: '评审前核对来源，演练除外。', value: '用于正式评审的来源核对。\n' + '保留来源和适用条件。\n'.repeat(160),
      suggestedType: 'rule', suggestedScope: 'review', ...RULE_BOUNDARY,
      sourceRefs: [{ kind: 'execution', id: 'synthetic-future-source' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
    expect(asset.value).toBe(candidate.value);
    expect(asset.statement).toBe(candidate.judgment);
    const nextUse = '用于正式评审和交付检查的来源核对。';
    const { proposal } = await approval.createAssetChangeProposal(uid, {
      assetId: asset.id, baselineVersion: asset.version, fields: ['value'], payload: { value: nextUse },
      beforeValues: { value: asset.value }, before: 'original future use', after: 'revised future use', reason: 'synthetic clarification',
    });
    expect((await assets.readAbilityAsset(uid, asset.id)).value).toBe(candidate.value);
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.ok).toBe(true);
    const saved = await assets.readAbilityAsset(uid, asset.id);
    expect(saved.value).toBe(nextUse);
    expect(saved.statement).toBe(candidate.judgment);
    expect(saved.scope).toBe(asset.scope);
    expect(saved.version).not.toBe(asset.version);
    expect((await assets.readAbilityAssetVersionSnapshot(uid, asset.id, asset.version))?.value).toBe(candidate.value);
    expect((await assets.readAbilityAssetVersionSnapshot(uid, asset.id, saved.version))?.value).toBe(nextUse);
  });
});


it('binds approval to the selected baseline as well as the latest counter', async () => {
  const uid = 'synthetic-selected-approval';
  const { assets, approval } = await modules();
  const original = await seedAsset(uid);
  const latest = await assets.updateAbilityAsset(uid, original.id, { value: '第二版用途', actor: 'user', reason: 'synthetic latest' });
  const { proposal } = await approval.createAssetChangeProposal(uid, { assetId: original.id, baselineVersion: latest.version,
    fields: ['value'], payload: { value: '拟保存用途' }, before: '', after: '', reason: 'synthetic proposal' });
  await assets.selectAbilityAssetVersion(uid, original.id, original.version, { actor: 'user', reason: 'synthetic switch' });
  const blocked = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
  expect(blocked.state).toBe('superseded');
  const selected = await assets.readAbilityAsset(uid, original.id);
  const next = await approval.createAssetChangeProposal(uid, { assetId: selected.id, baselineVersion: selected.version, baselineActiveVersion: selected.activeVersion, before: '', after: '', fields: ['value'], payload: { value: '旧版补用途' }, reason: 'synthetic selected proposal' });
  expect(next.proposal.baselineVersion).toBe(latest.version);
  expect(next.proposal.baselineActiveVersion).toBe(original.version);
  const result = await approval.decideAssetChangeProposal(uid, next.proposal.id, 'confirm');
  expect(result.ok).toBe(true);
  expect((await approval.readAssetChangeProposal(uid, next.proposal.id))?.appliedVersion).toBe(result.appliedVersion);
  expect((await assets.readAbilityAsset(uid, original.id)).value).toBe('旧版补用途');
});

it('restores an absent future use when rejection wins during confirmation', async () => {
  const uid = 'synthetic-future-race';
  const { assets, approval } = await modules();
  const original = await seedAsset(uid);
  const baseline = await assets.updateAbilityAsset(uid, original.id, { value: '', actor: 'user', reason: 'synthetic absent baseline' });
  const { proposal } = await approval.createAssetChangeProposal(uid, { assetId: baseline.id, baselineVersion: baseline.version,
    fields: ['value'], payload: { value: 'proposed future use' }, before: '', after: '', reason: 'synthetic concurrent decision' });
  const apply = assets.updateAbilityAsset;
  const intercepted = vi.spyOn(assets, 'updateAbilityAsset').mockImplementationOnce(async (...args) => {
    const saved = await apply(...args);
    await approval.decideAssetChangeProposal(uid, proposal.id, 'reject');
    return saved;
  });
  try {
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.state).toBe('rejected');
    expect(result.rollback).toMatchObject({ status: 'full', failedFields: [] });
    expect(result.message).toContain('已按提议前的值回滚');
    const restored = await assets.readAbilityAsset(uid, baseline.id);
    expect(restored.value).toBeUndefined();
    expect(restored.statement).toBe(baseline.statement);
    expect((await assets.readAbilityAssetVersionSnapshot(uid, restored.id, restored.version))?.value).toBeUndefined();
  } finally { intercepted.mockRestore(); }
});

it('reports a partial rollback when a field has no pre-proposal baseline', async () => {
  const uid = 'synthetic-partial-rollback';
  const { assets, approval } = await modules();
  const asset = await seedAsset(uid);
  const { proposal } = await approval.createAssetChangeProposal(uid, {
    assetId: asset.id,
    baselineVersion: asset.version,
    fields: ['statement', 'tags'],
    payload: { statement: '部分回滚目标正文。', tags: ['alpha'] },
    beforeValues: { statement: asset.statement },
    before: 'statement', after: 'statement+tags', reason: 'synthetic partial rollback',
  });
  const apply = assets.updateAbilityAsset;
  const intercepted = vi.spyOn(assets, 'updateAbilityAsset').mockImplementationOnce(async (...args) => {
    const saved = await apply(...args);
    await approval.decideAssetChangeProposal(uid, proposal.id, 'reject');
    return saved;
  });
  try {
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.rollback).toMatchObject({ status: 'partial', failedFields: ['tags'] });
    expect(result.message).toContain('未能回滚');
    const restored = await assets.readAbilityAsset(uid, asset.id);
    expect(restored.statement).toBe(asset.statement);
    expect(restored.tags).toEqual(['alpha']);
  } finally { intercepted.mockRestore(); }
});

it('reports a failed rollback and persists the recovery state', async () => {
  const uid = 'synthetic-failed-rollback';
  const { assets, approval } = await modules();
  const asset = await seedAsset(uid);
  const { proposal } = await proposeStatementChange(uid, asset.id, asset.version, '被拒绝但仍留在资产上的修改。');
  const apply = assets.updateAbilityAsset;
  let calls = 0;
  const intercepted = vi.spyOn(assets, 'updateAbilityAsset').mockImplementation(async (...args) => {
    calls += 1;
    if (calls === 1) {
      const saved = await apply(...args);
      await approval.decideAssetChangeProposal(uid, proposal.id, 'reject');
      return saved;
    }
    throw new Error('synthetic rollback failure');
  });
  try {
    const result = await approval.decideAssetChangeProposal(uid, proposal.id, 'confirm');
    expect(result.rollback).toMatchObject({ status: 'failed', failedFields: ['statement'] });
    expect(result.message).toContain('回滚失败');
    expect((await assets.readAbilityAsset(uid, asset.id)).statement).toBe('被拒绝但仍留在资产上的修改。');
    const persisted = await approval.readAssetChangeProposal(uid, proposal.id);
    expect(persisted?.rollback).toMatchObject({ status: 'failed', appliedVersion: expect.any(String) });
  } finally { intercepted.mockRestore(); }
});

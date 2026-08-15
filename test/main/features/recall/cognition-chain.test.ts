import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chain-')); previousRoot = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmpDir; });
afterEach(() => { if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previousRoot; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const UID = 'user-chain';

async function seedAsset(statement: string, tag: string) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(UID, {
    judgment: statement,
    suggestedType: 'rule',
    suggestedScope: 'delivery',
    sourceRefs: [{ kind: 'conversation', id: `conv-${tag}` }, { kind: 'execution', id: `exec-${tag}` }],
  });
  return candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' });
}

async function trace(assetId: string) {
  const { traceCognitionChainByAsset } = await import('../../../../src/main/features/recall/cognition-chain');
  return traceCognitionChainByAsset(UID, assetId);
}

function stage(view: Awaited<ReturnType<typeof trace>>, name: string) {
  return view.segments.find((s) => s.stage === name)!;
}

async function receiptFor(
  assetId: string,
  opts: { execution: string; session: string; used?: boolean; omittedReason?: string },
) {
  const { prepareReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
  return prepareReceipt(UID, {
    executionId: opts.execution,
    targetSessionId: opts.session,
    reusedRefs: opts.used === false ? [] : [`asset:${assetId}@v1`],
    omittedRefs: opts.omittedReason ? [`asset:${assetId}@v1:${opts.omittedReason}`] : [],
    permissionMode: 'read-only',
    allowedScopes: ['cognition:inherited'],
    boundary: 'real',
  }, { sessionId: opts.session });
}

async function inherit(agentId: string, asset: unknown) {
  const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
  return recordAgentInheritance(UID, {
    agentId,
    rolePrompt: `角色 ${agentId}`,
    assets: [asset as never],
    createdAt: new Date().toISOString(),
  });
}

describe('认知履历：段命名与状态词', () => {
  it('用用户语言的五段，不把 pack / receipt 这类实现名漏给用户', async () => {
    const { asset } = await seedAsset('动手前先对齐验收标准。', 'a');
    const view = await trace(asset.id);

    expect(view.segments.map((s) => s.stage)).toEqual([
      'formation', 'settling', 'inheritance', 'use', 'evidence',
    ]);
    // 用户可见文案里不得出现内部实现名。
    const userText = view.segments.map((s) => s.detail || '').join(' ');
    expect(userText).not.toMatch(/Capability Pack|ContextReuseReceipt|能力包|回执/);
  });

  it('未发生用 not_yet 而非进度词，措辞也不像欠了一步', async () => {
    const { asset } = await seedAsset('还没被用过的判断。', 'b');
    const view = await trace(asset.id);

    expect(stage(view, 'inheritance').status).toBe('not_yet');
    expect(stage(view, 'use').status).toBe('not_yet');
    // 「还没有」是事实陈述；不能出现「未完成 / 待完成 / 缺失」这类欠账措辞。
    expect(stage(view, 'use').detail).toBe('还没有在任务中用过');
    const userText = view.segments.map((s) => s.detail || '').join(' ');
    expect(userText).not.toMatch(/未完成|待完成|缺失|失败/);
  });

  it('只报可数的事实，不下「很稳」这类系统结论', async () => {
    const { asset } = await seedAsset('对外报价前过一遍内部口径。', 'c');
    await receiptFor(asset.id, { execution: 'exec-use-1', session: 'gmember-c-one' });

    const view = await trace(asset.id);
    expect(stage(view, 'use').detail).toBe('在 1 次任务中实际带入');
    const userText = view.segments.map((s) => s.detail || '').join(' ');
    expect(userText).not.toMatch(/稳|可靠|已验证|成熟|良好/);
  });
});

describe('认知履历：摘要用的计数', () => {
  it('数出来自几条来源、当前第几版', async () => {
    const { asset } = await seedAsset('两条来源的判断。', 'd');
    const view = await trace(asset.id);

    expect(stage(view, 'formation').count).toBe(2);
    expect(view.assetVersion).toBe('1');
    expect(stage(view, 'settling').detail).toContain('当前第 1 版');
  });

  it('数出进了几个智能体，并给出是哪几个', async () => {
    const { asset } = await seedAsset('被两个智能体带走的判断。', 'e');
    await inherit('ag-one', asset);
    await inherit('ag-two', asset);

    const view = await trace(asset.id);
    expect(view.carriedByAgentIds.sort()).toEqual(['ag-one', 'ag-two']);
    expect(stage(view, 'inheritance').detail).toBe('已进入 2 个智能体');
    // 进了智能体 ≠ 用过：两件事分开数。
    expect(view.usedInSessions).toBe(0);
    expect(stage(view, 'use').status).toBe('not_yet');
  });

  it('出生时被排除的资产，不算进「已进入几个智能体」', async () => {
    const { asset } = await seedAsset('被勾掉没带走的判断。', 'm');
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    await recordAgentInheritance(UID, {
      agentId: 'ag-excluded',
      rolePrompt: '角色',
      assets: [asset],
      excludedAssetIds: [asset.id],
      createdAt: new Date().toISOString(),
    });

    const view = await trace(asset.id);
    expect(view.carriedByAgentIds).toEqual([]);
    expect(stage(view, 'inheritance').status).toBe('not_yet');
  });

  it('数出在几次任务中实际带入', async () => {
    const { asset } = await seedAsset('被用过两次的判断。', 'f');
    await receiptFor(asset.id, { execution: 'exec-f-1', session: 'gmember-f-one' });
    await receiptFor(asset.id, { execution: 'exec-f-2', session: 'gmember-f-two' });

    const view = await trace(asset.id);
    expect(view.usedInSessions).toBe(2);
    expect(stage(view, 'use').detail).toBe('在 2 次任务中实际带入');
  });

  it('别的资产的使用记录不算在这条头上', async () => {
    const mine = await seedAsset('我的判断。', 'g');
    const other = await seedAsset('别人的判断。', 'h');
    await receiptFor(other.asset.id, { execution: 'exec-other', session: 'gmember-x-y' });

    expect((await trace(mine.asset.id)).usedInSessions).toBe(0);
    expect((await trace(other.asset.id)).usedInSessions).toBe(1);
  });
});

describe('认知履历：未使用原因', () => {
  it('本可用却没带上时，记下具体原因而不是沉默', async () => {
    const { asset } = await seedAsset('被暂停后没带上的判断。', 'i');
    await receiptFor(asset.id, {
      execution: 'exec-i-1', session: 'gmember-i-one', used: false, omittedReason: 'paused',
    });

    const view = await trace(asset.id);
    expect(view.withheld).toHaveLength(1);
    expect(view.withheld[0].reason).toBe('paused');
    expect(stage(view, 'evidence').status).toBe('happened');
    expect(stage(view, 'evidence').detail).toBe('1 次未带入，均有记录原因');
  });

  it('引用里没写原因时说 unknown，不拿资产 id 冒充一句解释', async () => {
    const { asset } = await seedAsset('未带入但没写原因。', 'o');
    const { prepareReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt(UID, {
      executionId: 'exec-o-1',
      targetSessionId: 'gmember-o-one',
      reusedRefs: [],
      omittedRefs: [`asset:${asset.id}@v1`],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: 'gmember-o-one' });

    const view = await trace(asset.id);
    expect(view.withheld[0].reason).toBe('unknown');
    expect(view.withheld[0].reason).not.toContain('@v1');
  });

  it('被拒的那次不算进「实际带入」', async () => {
    const { asset } = await seedAsset('这次复用被拒了。', 'p');
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await receiptFor(asset.id, { execution: 'exec-p-1', session: 'gmember-p-one' });
    await receipts.completeReceipt(UID, 'exec-p-1', { status: 'rejected' });

    const view = await trace(asset.id);
    expect(view.usedInSessions).toBe(0);
    expect(stage(view, 'use').status).toBe('not_yet');
  });

  it('没有未带入记录时如实说没有，不留悬念', async () => {
    const { asset } = await seedAsset('一直正常的判断。', 'j');
    const view = await trace(asset.id);
    expect(view.withheld).toEqual([]);
    expect(stage(view, 'evidence').detail).toBe('没有未带入记录');
  });
});

describe('认知履历：状态与断链如实反映', () => {
  it('撤销状态看得见，不被履历长度掩盖', async () => {
    const { asset } = await seedAsset('这条会被撤销。', 'k');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(UID, asset.id, { actor: 'user', reason: '口径已经变了' });

    const view = await trace(asset.id);
    expect(view.assetStatus).toBe('revoked');
    expect(stage(view, 'settling').detail).toContain('已撤销');
  });

  it('归档不说成撤销——拿走和否定是两件事', async () => {
    const { asset } = await seedAsset('这条会被归档。', 'n');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.archiveAbilityAsset(UID, asset.id, { actor: 'user', reason: '暂时不用了' });

    const view = await trace(asset.id);
    expect(view.assetStatus).toBe('archived');
    expect(stage(view, 'settling').detail).toContain('已归档');
    expect(stage(view, 'settling').detail).not.toContain('已撤销');
  });

  it('候选被清理后，形成段靠资产自带证据仍然成立', async () => {
    const { asset, candidate } = await seedAsset('候选稍后被删。', 'l');
    const { recallJsonRecordPath } = await import('../../../../src/main/features/recall/paths');
    fs.rmSync(recallJsonRecordPath(UID, 'candidates', candidate.id), { force: true });

    const view = await trace(asset.id);
    expect(stage(view, 'formation').status).toBe('happened');
    expect(view.candidateId).toBeUndefined();
    // 沉淀段是资产本身，候选没了也照样成立。
    expect(stage(view, 'settling').status).toBe('happened');
  });
});

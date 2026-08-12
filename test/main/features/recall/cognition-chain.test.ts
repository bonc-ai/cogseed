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
  return candidates.promoteRecallCandidate(UID, candidate.id);
}

async function trace(assetId: string) {
  const { traceCognitionChainByAsset } = await import('../../../../src/main/features/recall/cognition-chain');
  return traceCognitionChainByAsset(UID, assetId);
}

function stage(view: Awaited<ReturnType<typeof trace>>, name: string) {
  return view.segments.find((s) => s.stage === name)!;
}

describe('认知链路追溯', () => {
  it('刚沉淀的资产：前三段到达，后两段是「还没走到」而非失败', async () => {
    const { asset } = await seedAsset('动手前先对齐验收标准。', 'a');
    const view = await trace(asset.id);

    expect(stage(view, 'source').status).toBe('reached');
    expect(stage(view, 'source').count).toBe(2);
    expect(stage(view, 'candidate').status).toBe('reached');
    expect(stage(view, 'asset').status).toBe('reached');

    // 关键：未达到不是错误，措辞也不能像错误。
    expect(stage(view, 'pack').status).toBe('not_reached');
    expect(stage(view, 'pack').detail).toBe('还没进过任何能力包');
    expect(stage(view, 'reuse').status).toBe('not_reached');
    expect(stage(view, 'reuse').detail).toBe('还没有复用记录');
  });

  it('进过能力包后 pack 段到达，并数出进了几个智能体', async () => {
    const { asset } = await seedAsset('每个风险要有触发信号与处置人。', 'b');
    const { recordAgentInheritance } = await import('../../../../src/main/features/agent_inheritance');
    await recordAgentInheritance(UID, {
      agentId: 'ag-one', rolePrompt: '角色一', assets: [asset], createdAt: new Date().toISOString(),
    });
    await recordAgentInheritance(UID, {
      agentId: 'ag-two', rolePrompt: '角色二', assets: [asset], createdAt: new Date().toISOString(),
    });

    const view = await trace(asset.id);
    expect(stage(view, 'pack').status).toBe('reached');
    expect(stage(view, 'pack').count).toBe(2);
    expect(stage(view, 'pack').detail).toContain('2 个智能体');
    // 复用还没发生，仍是「还没走到」。
    expect(stage(view, 'reuse').status).toBe('not_reached');
  });

  it('有复用回执后 reuse 段到达，只报次数不下结论', async () => {
    const { asset } = await seedAsset('对外报价前过一遍内部口径。', 'c');
    const { prepareReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt(UID, {
      executionId: 'exec-reuse-1',
      targetSessionId: 'gmember-conv-c-ag-one',
      reusedRefs: [`asset:${asset.id}@v1`],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: 'gmember-conv-c-ag-one' });

    const view = await trace(asset.id);
    const reuse = stage(view, 'reuse');
    expect(reuse.status).toBe('reached');
    expect(reuse.count).toBe(1);
    // 只给用户能自己判断的事实，不出现「很稳」「已验证」这类系统结论。
    expect(reuse.detail).toBe('被 1 次任务真实带入');
    expect(reuse.detail).not.toMatch(/稳|可靠|已验证|成熟/);
  });

  it('别的资产的回执不算在这条头上', async () => {
    const mine = await seedAsset('我的判断。', 'd');
    const other = await seedAsset('别人的判断。', 'e');
    const { prepareReceipt } = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    await prepareReceipt(UID, {
      executionId: 'exec-other-1',
      targetSessionId: 'gmember-x-y',
      reusedRefs: [`asset:${other.asset.id}@v1`],
      omittedRefs: [],
      permissionMode: 'read-only',
      allowedScopes: ['cognition:inherited'],
      boundary: 'real',
    }, { sessionId: 'gmember-x-y' });

    expect(stage(await trace(mine.asset.id), 'reuse').status).toBe('not_reached');
    expect(stage(await trace(other.asset.id), 'reuse').count).toBe(1);
  });

  it('撤销状态在追溯里看得见，不被链路进度掩盖', async () => {
    const { asset } = await seedAsset('这条会被撤销。', 'f');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.revokeAbilityAsset(UID, asset.id, 'unsafe');

    const view = await trace(asset.id);
    expect(view.assetStatus).toBe('revoked');
    expect(stage(view, 'asset').detail).toContain('已撤销');
  });

  it('候选被清理后如实报告溯源链断节，不假装完整', async () => {
    const { asset, candidate } = await seedAsset('候选稍后被删。', 'g');
    const { recallJsonRecordPath } = await import('../../../../src/main/features/recall/paths');
    fs.rmSync(recallJsonRecordPath(UID, 'candidates', candidate.id), { force: true });

    const view = await trace(asset.id);
    expect(stage(view, 'candidate').status).toBe('not_reached');
    expect(stage(view, 'candidate').detail).toContain('断了一节');
    // 资产自带证据，来源段仍然成立。
    expect(stage(view, 'source').status).toBe('reached');
  });
});

/**
 * 「记一条」手动候选的证据豁免（2026-09-28 四病整改拍板项，设计 7.2）。
 *
 * 守三条：
 *   ① manual=true 且 sourceRefs 为空 → 直接 pending_review（不落
 *      weak_observation），origin='manual' 落盘，能力层可确认可晋升；
 *   ② 豁免不外溢：同一保存通道不带 manual 标记的空证据候选仍走
 *      weak_observation 且 canConfirm=false（自动线的证据闸原样）；
 *   ③ 晋升贯通：manual 候选确认后资产创建成功、evidenceRefs 空数组合法、
 *      origin 透传到资产、listAbilityAssets 读回不炸（asAsset 同款放行）。
 *
 * 豁免的安全边界：证据闸防的是自动提炼线编造来源冒充有据；用户亲自输入
 * 的候选没有"来源可伪造"面——它本身就是来源。伪造 sourceRefs 解锁晋升
 * 的老威胁模型不受影响（manual 路径根本不带 refs）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-manual-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets, capabilities] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/candidate-capabilities'),
  ]);
  return { candidates, assets, capabilities };
}

describe('「记一条」手动候选豁免', () => {
  it('manual 保存：空来源直接 pending_review、origin 落盘、能力层可确认', async () => {
    const uid = 'user-manual-save';
    const { candidates, capabilities } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: '发布会前必须过一遍演示清单。',
      value: '避免现场翻车的最后一道闸。',
      summary: '发布会演示清单闸',
      suggestedType: 'rule',
      suggestedScope: 'product',
      suggestedAction: 'create',
      applicableWhen: ['preparing a launch demo'],
      forbiddenWhen: ['routine internal sync'],
      sourceRefs: [],
      manual: true,
    });
    expect(candidate.status).toBe('pending_review');
    expect(candidate.origin).toBe('manual');
    expect(candidate.sourceRefs).toEqual([]);
    const caps = capabilities.getRecallCandidateCapabilities(candidate);
    expect(caps.canConfirm).toBe(true);
    expect(caps.canPromote).toBe(true);
    expect(caps.disabledReason).toBeUndefined();
  });

  it('豁免不外溢：不带 manual 的空证据候选仍是 weak_observation 且不可确认', async () => {
    const uid = 'user-manual-nospill';
    const { candidates, capabilities } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: '自动提炼线的样本判断。',
      value: '它没有来源，必须被证据闸拦住。',
      summary: '无来源自动样本',
      suggestedType: 'fact',
      suggestedScope: 'general',
      sourceRefs: [],
    });
    expect(candidate.status).toBe('weak_observation');
    expect(candidate.origin).toBe('capture');
    const caps = capabilities.getRecallCandidateCapabilities(candidate);
    expect(caps.canConfirm).toBe(false);
    expect(caps.disabledReason).toBe('candidate_evidence_insufficient');
  });

  it('晋升贯通：manual 候选确认成资产，空证据与 origin 标记都读回不炸', async () => {
    const uid = 'user-manual-promote';
    const { candidates, assets } = await modules();
    const candidate = await candidates.saveRecallCandidate(uid, {
      judgment: '对外汇报一律结论先行。',
      value: '读者时间有限，结论先到才有人看论据。',
      summary: '汇报先给结论再给依据',
      suggestedType: 'rule',
      suggestedScope: 'report',
      suggestedAction: 'create',
      applicableWhen: ['writing external reports'],
      forbiddenWhen: ['casual internal chat'],
      sourceRefs: [],
      manual: true,
    });
    const promoted = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
    expect(promoted.asset.evidenceRefs).toEqual([]);
    expect((promoted.asset as { origin?: string }).origin).toBe('manual');
    // 读回路径（asAsset 放行）：空证据 + origin=manual 的资产在列表里完好。
    const listed = await assets.listAbilityAssets(uid);
    const found = listed.find((row) => row.id === promoted.asset.id);
    expect(found).toBeDefined();
    expect(found?.evidenceRefs).toEqual([]);
    expect((found as { origin?: string }).origin).toBe('manual');
  });
});

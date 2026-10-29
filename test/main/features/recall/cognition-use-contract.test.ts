import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateAssetRuntimeEligibility } from '../../../../src/main/features/recall/formal-assets/runtime';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';

let root: string;
let previous: string | undefined;
const uid = 'user-use-contract';
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-use-contract-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
function asset(extra: Partial<RecallAbilityAssetRecord> = {}): RecallAbilityAssetRecord {
  return {
    id: 'aa-use-one', ownerId: uid, status: 'active', maturity: 'seed', scope: 'general',
    type: 'personal', title: '画像偏好', statement: '回答问题时先说明结论。', evidenceRefs: [],
    updatedAt: '2026-01-01T00:00:00Z', version: '1', ...extra,
  } as RecallAbilityAssetRecord;
}

describe('共同使用契约跨入口反例', () => {
  it('未验证内容可查阅与明确选用，但不得默认带入或伪装自动许可', async () => {
    const gate = await import('../../../../src/main/features/recall/prompt-injection');
    const item = asset();
    expect(await gate.filterRecallAssetsForAgentRead(uid, [item])).toEqual([item]);
    expect(await gate.filterRecallAssetsForCommittedProjection(uid, [item])).toEqual([item]);
    expect(await gate.filterRecallAssetsForDefaultInjection(uid, [item])).toEqual([]);
    for (const operation of ['inspect', 'explicit_use', 'default_injection'] as const) {
      const result = evaluateAssetRuntimeEligibility(item, { operation });
      expect(result.eligible && result.usePolicy === 'never').toBe(false);
      expect(result.defaultUsePolicy).toBe('never');
    }
  });

  it('个人记忆默认使用需要真实用户决定，不信任 lifecycle 自述或系统决定', async () => {
    const gate = await import('../../../../src/main/features/recall/prompt-injection');
    const decisions = await import('../../../../src/main/features/cognition/review-decision');
    const item = asset({ candidateId: 'cand-use-personal', maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified' });
    expect(await gate.filterRecallAssetsForDefaultInjection(uid, [item])).toEqual([]);
    const decision = await decisions.writeReviewDecision(uid, {
      targetRef: 'recall_candidate:cand-use-personal', decisionType: 'accept', decision: 'accept', antecedentRef: 'cand-use-personal', scope: 'general', actor: 'user',
    });
    const confirmed = { ...item, reviewDecisionId: decision.decision_id };
    expect(await gate.filterRecallAssetsForDefaultInjection(uid, [confirmed])).toEqual([confirmed]);
    expect(confirmed.maturity).toBe('bud');
    expect((await gate.evaluateRecallAssetRuntimeEligibility(uid, confirmed, { operation: 'default_injection', sourceAvailable: false })).eligible).toBe(false);
    const automatic = await decisions.writeReviewDecision(uid, {
      targetRef: 'recall_candidate:cand-use-personal', decisionType: 'accept', decision: 'automatic capture', scope: 'general', actor: 'system',
    });
    expect(await gate.filterRecallAssetsForDefaultInjection(uid, [{ ...item, reviewDecisionId: automatic.decision_id }])).toEqual([]);
  });

  it('相关性与权限分开返回；未知相关性不阻断默认策略', async () => {
    const gate = await import('../../../../src/main/features/recall/prompt-injection');
    const item = asset({ maturity: 'transfer_validated', applicableWhen: ['性能排查'] });
    const context = { taskText: '写一份周报' };
    const read = await gate.evaluateRecallAssetAgentReadEligibility(uid, item, context);
    // 未命中自由文本适用条件只证明「未知」，不证明「不适用」：相关性单独返回，
    // 默认带入仍由 maturity/scope 契约决定（transfer_validated 同作用域可默认带入）。
    expect(read).toMatchObject({ operation: 'inspect', accessAllowed: true, relevance: 'unknown', eligible: true, mode: 'default_allowed', usePolicy: 'auto', defaultUsePolicy: 'auto' });
    expect(await gate.filterRecallAssetsForAgentRead(uid, [item], context)).toEqual([item]);
    expect(await gate.filterRecallAssetsForDefaultInjection(uid, [item], context)).toEqual([item]);
    expect(await gate.filterRecallAssetsForCommittedProjection(uid, [item], context)).toEqual([item]);
  });

  it.each(['inspect', 'explicit_use', 'default_injection'] as const)('%s 无法绕过状态、撤权、项目与禁止条件', operation => {
    const result = evaluateAssetRuntimeEligibility(asset({
      status: 'paused', maturity: 'effectiveness_validated',
      scopePolicy: { projectIds: ['project-a'] }, forbiddenWhen: ['公开分享'],
    }), { operation, sourceAvailable: false, projectId: 'project-b', taskText: '公开分享' });
    expect(result).toMatchObject({ accessAllowed: false, eligible: false, usePolicy: 'never', mode: 'blocked' });
    expect(result.reasons).toEqual(expect.arrayContaining(['status_not_active', 'source_unavailable', 'scope_mismatch', 'forbidden_context']));
  });

  it('默认画像走真实 Map 统计读取，不能退化为更新时间排序', async () => {
    const usage = await import('../../../../src/main/features/recall/usage-service');
    await usage.recordRecallUsage(uid, { assetId: 'aa-used-old', assetVersion: '1', taskRunId: 'task-one' });
    const profile = await import('../../../../src/main/features/recall/profile-block');
    const older = asset({ id: 'aa-used-old', maturity: 'transfer_validated', statement: '高频旧偏好。' });
    const newer = asset({ id: 'aa-unused-new', maturity: 'transfer_validated', statement: '低频新偏好。', updatedAt: '2026-02-01T00:00:00Z' });
    const result = await profile.loadAssetProfileEntries(uid, { listAssets: async () => [newer, older] });
    expect(result).toEqual(['高频旧偏好。', '低频新偏好。']);
  });

  it('画像仍排除未验证内容；未命中的适用范围不阻断已验证资产的默认带入', async () => {
    const profile = await import('../../../../src/main/features/recall/profile-block');
    const unknown = asset({ maturity: 'bud', statement: '未验证的画像偏好。' });
    const unrelated = asset({ id: 'aa-use-unrelated', maturity: 'transfer_validated', statement: '性能排查专用偏好。', applicableWhen: ['性能排查'] });
    const result = await profile.loadAssetProfileEntriesWithAvailability(uid, {
      listAssets: async () => [unknown, unrelated], readContext: { taskText: '编写周报' },
    });
    // bud 不具备默认使用资格；transfer_validated 的适用条件是软提示，文本未命中
    // 只标 unknown，不把整条已验证偏好挡在画像之外。
    expect(result).toEqual({ entries: ['性能排查专用偏好。'], hasPersonalAssets: true });
  });
});

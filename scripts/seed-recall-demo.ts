/** Dev-only demo seed for the Recall Asset Center. Safe to rerun. */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

async function main(): Promise<void> {
const dataRoot = path.join(process.env.HOME || '', '.cogseed', 'data');
process.env.COGSEED_WORKSPACE_ROOT = dataRoot;

const users = JSON.parse(await fs.readFile(path.join(dataRoot, 'users.json'), 'utf8')) as {
  current_user_id?: string;
  dev_current_user_id?: string;
};
const userIds = Array.from(new Set([users.current_user_id, users.dev_current_user_id].filter((id): id is string => Boolean(id))));

const candidates = await import('../src/main/features/recall/candidate-service');
const assets = await import('../src/main/features/recall/asset-service');
const refs = await import('../src/main/features/recall/workspace-refs');
const projections = await import('../src/main/features/recall/context-projection');
const proofs = await import('../src/main/features/recall/proof-service');
const tree = await import('../src/main/features/recall/tree-service');

const demos = [
  {
    judgment: '评审架构方案前先建立决策记录，并保留来源与反对意见。',
    summary: '架构评审需要决策记录与证据',
    type: 'rule' as const,
    scope: 'review,project',
    refs: [{ kind: 'execution' as const, id: 'demo-exec-day-4' }, { kind: 'memory' as const, id: 'demo-memory-architecture' }],
    outcome: 'better' as const,
  },
  {
    judgment: '发布前的变更说明应包含风险、回滚条件和验证结果。',
    summary: '发布说明必须包含风险与回滚条件',
    type: 'template' as const,
    scope: 'review,project',
    refs: [{ kind: 'artifact' as const, id: 'demo-artifact-release-note' }, { kind: 'execution' as const, id: 'demo-exec-day-3' }],
    outcome: 'better' as const,
  },
  {
    judgment: '涉及用户偏好的结论必须标注证据强度，证据不足时先暂缓。',
    summary: '偏好结论需要证据强度',
    type: 'personal' as const,
    scope: 'review,project',
    refs: [{ kind: 'memory' as const, id: 'demo-memory-preference' }, { kind: 'conversation' as const, id: 'demo-conversation-day-2' }],
    outcome: 'worse' as const,
  },
] as const;

for (const userId of userIds) {
  for (let index = 0; index < demos.length; index += 1) {
    const demo = demos[index];
    const candidate = await candidates.saveRecallCandidate(userId, {
      judgment: demo.judgment,
      summary: demo.summary,
      suggestedType: demo.type,
      suggestedScope: demo.scope,
      sourceRefs: demo.refs,
    });
    const promoted = await candidates.promoteRecallCandidate(userId, candidate.id);
    await refs.addWorkspaceAssetReference(userId, {
      assetId: promoted.asset.id,
      workspaceId: 'demo-workspace',
      scope: 'review,project',
    });
    if (index === 0) {
      await assets.updateAbilityAsset(userId, promoted.asset.id, {
        statement: '评审架构方案前先建立决策记录，保留来源、反对意见和最终取舍。',
      });
    }
    const preview = await projections.previewContextProjection(userId, {
      taskRunId: `demo-task-day-${4 - index}`,
      workspaceId: 'demo-workspace',
      purpose: 'review',
      authorization: 'user_confirmed',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const confirmed = await projections.confirmContextProjection(userId, preview.id);
    const transfer = await proofs.prepareTransferProof(userId, {
      projectionId: confirmed.id,
      executionId: `demo-exec-day-${4 - index}`,
      expectedResultSnapshot: '输出中包含可追溯来源、适用范围与下一步验证。',
    });
    await proofs.completeTransferProof(userId, transfer.id, {
      status: 'succeeded',
      receiptId: `demo-receipt-day-${4 - index}`,
      observedTransfer: '已将正式能力资产作为本次评审上下文的一部分使用。',
    });
    await proofs.evaluateEffectivenessProof(userId, {
      transferProofId: transfer.id,
      outcome: demo.outcome,
      observedResult: demo.outcome === 'better' ? '评审结论更完整，遗漏的来源引用减少。' : '本次复用造成范围过宽，需要人工重新审查。',
      evidenceRefs: [{ kind: 'artifact', id: `demo-evidence-day-${4 - index}` }],
    });
  }
  await candidates.saveRecallCandidate(userId, {
    judgment: '在产品方案评审前，先明确用户目标、证据来源与尚未验证的假设。',
    summary: '产品评审前需要确认目标、证据与假设',
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    sourceRefs: [{ kind: 'conversation', id: 'demo-pending-conversation' }, { kind: 'artifact', id: 'demo-pending-brief' }],
  });
  await tree.rebuildCognitionTree(userId);
}

console.log(JSON.stringify({ ok: true, users: userIds, seeded: demos.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

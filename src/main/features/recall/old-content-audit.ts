/** Per-asset audit events for old-content plans. The execution receipt is the
 * source of truth; replay is idempotent through a deterministic event id. */
import { createHash } from 'node:crypto';
import { listAbilityAssetAudit, recordAbilityAssetAudit } from './asset-service';
import { readOldContentPlan, saveOldContentPlan } from './old-content-plan-service';
import type { OldContentExecution, OldContentPlanRecord } from './old-content-plan-contract';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface OldContentAuditOutcome {
  state: 'complete' | 'pending' | 'drifted';
  attempts: number;
}

function auditEventId(executionId: string, assetId: string, action: 'old_content_applied' | 'old_content_undone') {
  return hash([executionId, assetId, action]).slice(0, 24);
}
function changedAssetIds(execution: OldContentExecution): string[] {
  return Object.keys(execution.snapshot?.after || {});
}
function itemForAsset(execution: OldContentExecution, assetId: string) {
  return execution.items.find(item => (item.archivedIds || []).includes(assetId)
    || (item.deletedIds || []).includes(assetId) || item.targetAssetId === assetId);
}

async function writeExecutionAudit(userId: string, planId: string, execution: OldContentExecution): Promise<boolean> {
  const actions: Array<'old_content_applied' | 'old_content_undone'> = execution.undoneAt
    ? ['old_content_applied', 'old_content_undone'] : ['old_content_applied'];
  let ok = true;
  for (const assetId of changedAssetIds(execution)) {
    const item = itemForAsset(execution, assetId);
    for (const action of actions) {
      const eventId = auditEventId(execution.executionId, assetId, action);
      try {
        const existing = await listAbilityAssetAudit(userId, assetId);
        if (existing.some(row => row.eventId === eventId)) continue;
        await recordAbilityAssetAudit(userId, assetId, action, {
          actor: 'user',
          reason: action === 'old_content_applied' ? '旧内容整理：按方案处理' : '旧内容整理：撤销本次处理',
          eventId,
          refs: {
            planId,
            ...(execution.candidateId ? { candidateId: execution.candidateId } : {}),
            executionId: execution.executionId,
            decisionId: action === 'old_content_undone'
              ? execution.undoDecisionId || execution.decisionId : execution.decisionId,
            ...(item ? { itemId: item.itemId } : {}),
            ...(item?.targetAssetId ? { targetAssetId: item.targetAssetId } : {}),
            ...(item?.targetVersion ? { targetVersion: item.targetVersion } : {}),
          },
        });
      } catch {
        ok = false;
      }
    }
  }
  return ok;
}

export async function applyOldContentExecutionAudit(userId: string, planId: string,
  execution: OldContentExecution, attempts = 1): Promise<OldContentAuditOutcome> {
  const ok = await writeExecutionAudit(userId, planId, execution);
  return { state: ok ? 'complete' : attempts >= 3 ? 'drifted' : 'pending', attempts };
}

/** Retry pending audits from the receipts. Never touches business state. */
export async function reconcileOldContentAudit(userId: string, planId: string): Promise<OldContentPlanRecord> {
  const plan = await readOldContentPlan(userId, planId);
  let changed = false;
  const executions: OldContentExecution[] = [];
  for (const execution of plan.executions) {
    if (!execution.snapshot || execution.audit?.state === 'complete') {
      executions.push(execution);
      continue;
    }
    const attempts = (execution.audit?.attempts || 0) + 1;
    const outcome = await applyOldContentExecutionAudit(userId, plan.id, execution, attempts);
    executions.push({ ...execution, audit: outcome });
    changed = true;
  }
  return changed ? saveOldContentPlan(userId, { ...plan, executions, updatedAt: new Date().toISOString() }) : plan;
}

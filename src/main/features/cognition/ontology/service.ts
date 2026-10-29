/** 本体提交与读取复用认知主档、transition → document锁和坏档拒写。 */
import { randomUUID } from 'node:crypto';
import { withCognitionTransition } from '../../cognition_bridge';
import { cognitionStorePath, applyCognitionDeltas, loadCognitionStoreSync, assertCognitionCommitActive, archiveCognitionOntologyHistory } from '../../cognition_kernel/store';
import { corruptRecordFor } from '../../../util/corrupt-guard';
import { notifyCognitionWrite } from '../../recall/store-events';
import { applyOntologyCommand, validateOntologyCommand, type OntologyCommandOutcome, type OntologyCommandSourceOverride } from './commands';
import { emptyOntologyDocument, OntologyError, validateOntologyDocument, type OntologyDocument, type OntologyRecord } from './model';
import { ontologyScopeViolations } from './cognition-scope';
import type { RecallAbilityAssetScopePolicy } from '../../recall/scope-policy';
import type { CognitionEditDecision } from '../edit-decision';

export function readOntologyDocument(userId: string): OntologyDocument {
  const empty = emptyOntologyDocument(userId);
  const doc = loadCognitionStoreSync(userId);
  if (corruptRecordFor(cognitionStorePath(userId))) throw new OntologyError('store_corrupt', 'cognition store unreadable; ontology read refused');
  if (!doc.ontology) return empty;
  const result = validateOntologyDocument(doc.ontology);
  if (result.ownerId !== userId) throw new OntologyError('store_corrupt', 'ontology owner mismatch');
  return result;
}
export async function readOntologyView(userId: string): Promise<OntologyDocument> {
  const canonical = readOntologyDocument(userId);
  const legacy = await import('./legacy-view');
  return legacy.readOntologyWithLegacyView(canonical, userId);
}
export function previewOntologyCommand(userId: string, input: unknown): OntologyCommandOutcome {
  return applyOntologyCommand(readOntologyDocument(userId), input, new Date().toISOString());
}
export async function commitOntologyCommand(userId: string, input: unknown, sourceOverride?: OntologyCommandSourceOverride, userEditDecision?: CognitionEditDecision): Promise<Omit<OntologyCommandOutcome, 'document'>> {
  let result: OntologyCommandOutcome;
  try {
    const outcome = await withCognitionTransition(userId, () => {
      const current = readOntologyDocument(userId);
      const command = validateOntologyCommand(input);
      for (const action of command.actions) {
        if (action.intent === 'create') continue;
        if (action.intent === 'undo_command' && current.history.some(row => row.commandId === action.originalCommandId
          && row.after.kind === 'rule' && current.records[row.after.id]?.source.refs?.some(ref => ref.kind === 'asset')))
          throw new OntologyError('shared_body_requires_cognition', 'shared rule undo requires its cognition in the same commit');
        const rule = current.records[action.recordId];
        if (rule?.kind === 'rule' && rule.source.refs?.some(ref => ref.kind === 'asset')
          && ((action.intent === 'update' && ['requirement', 'status'].some(key => Object.hasOwn(action.patch, key)))
            || ['archive', 'delete', 'restore', 'undo_command'].includes(action.intent)))
          throw new OntologyError('shared_body_requires_cognition', 'shared rule text and lifecycle must be changed with its cognition');
      }
      const compatibility = loadCognitionStoreSync(userId).compatibility;
      if (compatibility && command.actions.some(action => action.intent !== 'create' && action.intent !== 'change' && action.intent !== 'correct')) {
        const previewOutcome = applyOntologyCommand(current, command, new Date().toISOString(), sourceOverride);
        const preview = previewOutcome.document;
        const changed = new Set(previewOutcome.receipt.changedIds);
        const changedModules = new Set(previewOutcome.receipt.changedIds.filter(id => preview.records[id].kind === 'module'));
        for (const record of Object.values(preview.records)) {
          if (!changed.has(record.id) && !(record.kind !== 'module' && changedModules.has(record.moduleId))) continue;
          const assetId = record.source.refs?.find(ref => ref.kind === 'asset')?.id
            ?? (record.source.kind === 'candidate' && record.source.recordId
              ? compatibility.records.candidates[record.source.recordId]?.promotedAssetId : undefined);
          if (typeof assetId !== 'string') continue;
          const policy = compatibility.records['ability-assets'][assetId]?.scopePolicy as RecallAbilityAssetScopePolicy | undefined;
          if (ontologyScopeViolations(preview, [record], policy).length)
            throw new OntologyError('formation_blocked', 'ontology edits would exceed the linked cognition scope');
        }
      }
      return applyCognitionDeltas(userId, { kind: 'ontology', command: input, sourceOverride, userEditDecision });
    });
    if (corruptRecordFor(cognitionStorePath(userId))) throw new OntologyError('store_corrupt', 'cognition store corrupt; write refused');
    if (!outcome.ok && outcome.error === 'cognition store capacity exceeded') throw new OntologyError('capacity_exceeded', outcome.error);
    if (!outcome.ok || !outcome.ontology) throw new OntologyError('commit_failed', outcome.error || 'ontology commit failed');
    result = { document: readOntologyDocument(userId), ...outcome.ontology };
  } catch (error) {
    assertCognitionCommitActive(userId);
    if (error instanceof OntologyError) throw error;
    if (corruptRecordFor(cognitionStorePath(userId))) throw new OntologyError('store_corrupt', 'cognition store corrupt; ontology write refused');
    throw new OntologyError('commit_failed', 'ontology commit failed');
  }
  if (!result.duplicate) notifyCognitionWrite(userId, 'ontology', 'update');
  return { receipt: result.receipt, duplicate: result.duplicate };
}

/**
 * Move old ontology history/receipts to a sideline file and trim the live
 * document. The store writes and fsyncs the sideline before replacing the main
 * file; this wrapper adds transition locking and the renderer refresh signal.
 */
export async function archiveOntologyHistory(userId: string, keepHistory: number, keepReceipts: number): Promise<{
  archivedHistory: number; archivedReceipts: number; archivePath?: string;
}> {
  let outcome: Awaited<ReturnType<typeof archiveCognitionOntologyHistory>>;
  try {
    outcome = await withCognitionTransition(userId, () => archiveCognitionOntologyHistory(userId, { keepHistory, keepReceipts }));
  } catch (error) {
    assertCognitionCommitActive(userId);
    if (error instanceof OntologyError) throw error;
    if (corruptRecordFor(cognitionStorePath(userId))) throw new OntologyError('store_corrupt', 'cognition store corrupt; archive refused');
    throw new OntologyError('commit_failed', 'ontology history archive failed');
  }
  if (!outcome.ok) {
    if (/invalid archive bounds/.test(outcome.error || '')) throw new OntologyError('invalid_input', outcome.error!);
    if (/corrupt/.test(outcome.error || '')) throw new OntologyError('store_corrupt', outcome.error!);
    throw new OntologyError('commit_failed', outcome.error || 'ontology history archive failed');
  }
  if (outcome.archivedHistory || outcome.archivedReceipts) notifyCognitionWrite(userId, 'ontology', 'update');
  return { archivedHistory: outcome.archivedHistory, archivedReceipts: outcome.archivedReceipts,
    ...(outcome.archivePath ? { archivePath: outcome.archivePath } : {}) };
}

/**
 * 「本体整体暂停」退役的结构迁移。旧 paused 模块的
 * 在用内容逐条置为 paused（不静默扩大可用性），模块本身恢复 active
 * （模块级暂停概念删除，可用性由条目自身状态决定）。走标准命令通道：
 * 每步入版本历史、可恢复、commandId 稳定幂等，重复执行为 no-op。
 */
export async function retireOntologyModulePause(userId: string): Promise<{ migratedModules: number; pausedRecords: number }> {
  let migratedModules = 0;
  let pausedRecords = 0;
  for (;;) {
    const doc = readOntologyDocument(userId);
    const pausedModule = Object.values(doc.records).find((record): record is Extract<OntologyRecord, { kind: 'module' }> => (
      record.kind === 'module' && record.status === 'paused'
    ));
    if (!pausedModule) break;
    const moduleRecords = Object.values(doc.records)
      .filter((record) => record.kind !== 'module' && record.moduleId === pausedModule.id && record.status === 'active');
    await commitOntologyCommand(userId, {
      commandId: `retire-module-pause-${pausedModule.id}`,
      expectedRevision: doc.revision,
      actions: [
        { intent: 'update', recordId: pausedModule.id, expectedVersion: pausedModule.version, patch: { status: 'active' }, sourceLabel: 'module-pause-retirement' },
        ...moduleRecords.map((record) => ({
          intent: 'update' as const,
          recordId: record.id,
          expectedVersion: record.version,
          patch: { status: 'paused' as const },
          sourceLabel: 'module-pause-retirement',
        })),
      ],
    });
    migratedModules += 1;
    pausedRecords += moduleRecords.length;
  }
  return { migratedModules, pausedRecords };
}

/** 卡片生命周期复用主档命令与版本校验。旧来源只保存模块状态，内容仍由只读投影提供。 */
export async function changeOntologyModuleLifecycle(userId: string, input: {
  moduleId: string; intent: 'archive' | 'delete' | 'restore'; expectedRevision: number; expectedVersion: number;
}) {
  const doc = readOntologyDocument(userId);
  if (doc.revision !== input.expectedRevision) throw new OntologyError('baseline_changed', 'ontology revision changed');
  const view = await readOntologyView(userId);
  const module = view.records[input.moduleId];
  if (!module || module.kind !== 'module') throw new OntologyError('not_found', 'ontology module not found');
  if (module.version !== input.expectedVersion) throw new OntologyError('baseline_changed', 'ontology module version changed');
  const legacy = !doc.records[module.id] && module.source.kind === 'legacy';
  if (legacy && input.intent === 'restore') throw new OntologyError('invalid_intent', 'module is already active');
  const sourceLabel = '用户确认本体生命周期';
  const actions: import('./commands').OntologyAction[] = [];
  if (legacy) actions.push({ intent: 'create', recordId: module.id, sourceLabel,
    record: { kind: 'module', name: module.name, description: module.description, scope: module.scope, access: module.access } });
  actions.push({ intent: input.intent, recordId: module.id, expectedVersion: legacy ? 1 : module.version, sourceLabel });
  const result = await commitOntologyCommand(userId, {
    commandId: `module-${randomUUID()}`, expectedRevision: input.expectedRevision, actions,
  }, module.source.kind === 'legacy' ? { kind: 'legacy', recordId: module.id, label: sourceLabel } : undefined);
  const saved = readOntologyDocument(userId).records[module.id];
  if (!result.receipt.changedIds.includes(module.id) || saved?.status !== (input.intent === 'restore' ? 'active' : 'archived'))
    throw new OntologyError('commit_failed', 'module lifecycle read-back failed');
  return result;
}

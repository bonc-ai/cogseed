/** Historical feedback never silently evaluates today's asset body. Read the
 * exact assessed version and current version under today's source/scope grant. */
import { readAbilityAsset, readAbilityAssetVersionSnapshot } from './asset-service';
import { getConversation } from '../chats';
import { readGroupExecutionResult, readDispatchSourceMessage, readDispatchBindingContext } from './execution-result-content';
import { listInjectionReceipts } from './injection-receipt';
import type { CognitionSourceRef } from './source-service';
import type { PersistedResultContent } from './persisted-result-content';
import type { NightlyFeedbackObservation } from './nightly-feedback';
export async function readFeedbackVersionContext(userId: string, cid: string, observations: NightlyFeedbackObservation[]) {
  if (!observations.length) return [];
  const conversation = await getConversation(userId, cid);
  const context = { projectId: conversation?.project_id || undefined, workspaceId: conversation?.space_id || undefined,
    conversationKind: conversation?.kind || undefined };
  const { filterRecallAssetsForAgentRead } = await import('./prompt-injection');
  return Promise.all(observations.map(async observation => {
    try {
      const resultContext = observation.resultSource ? await readFeedbackResultContext(userId, cid, observation) : undefined;
      const readContext = resultContext?.readContext || context;
      const head = await readAbilityAsset(userId, observation.assetId);
      const evaluated = await readAbilityAssetVersionSnapshot(userId, head.id, observation.assetVersion);
      const currentVersion = String(head.activeVersion || head.version);
      const current = await readAbilityAssetVersionSnapshot(userId, head.id, currentVersion);
      if (!evaluated || !current || !(await filterRecallAssetsForAgentRead(userId, [head], readContext)).length
        || !(await filterRecallAssetsForAgentRead(userId, [{ ...head, ...evaluated, scope: head.scope,
          scopePolicy: head.scopePolicy, status: head.status, evidenceRefs: evaluated.evidenceRefs || head.evidenceRefs }], readContext)).length) throw new Error('feedback source unavailable');
      if (!(await filterRecallAssetsForAgentRead(userId, [{ ...head, ...current, scope: head.scope,
        scopePolicy: head.scopePolicy, status: head.status, evidenceRefs: current.evidenceRefs || head.evidenceRefs }], readContext)).length) throw new Error('current feedback source unavailable');
      const after = await readAbilityAsset(userId, head.id);
      if (JSON.stringify(after) !== JSON.stringify(head)) throw new Error('feedback baseline changed');
      return { ...observation, ...(resultContext ? { resultContext } : {}), versionContext: { status: currentVersion === observation.assetVersion ? 'current' : 'historical',
        evaluated: { version: observation.assetVersion, statement: evaluated.statement, applicableWhen: evaluated.applicableWhen, forbiddenWhen: evaluated.forbiddenWhen },
        current: { version: currentVersion, statement: current.statement, applicableWhen: current.applicableWhen, forbiddenWhen: current.forbiddenWhen } } };
    } catch { return { ...observation, ...(observation.resultSource ? { resultContext: { status: 'unavailable' as const } } : {}), versionContext: { status: 'unavailable' } }; }
  }));
}


export type FeedbackResultContext = ({ status: 'available'; fingerprint: string; sourceRefs: CognitionSourceRef[]; readContext?: import('./prompt-injection').RecallAgentReadContext } & PersistedResultContent)
  | { status: 'unavailable' };
/** Supplementary execution evidence keeps its own source identity and never
 * becomes user-authored text or permission to form a rule without user input. */
export async function readFeedbackResultContext(userId: string, cid: string,
  observation: Pick<NightlyFeedbackObservation, 'messageId' | 'assetId' | 'assetVersion' | 'resultSource'>): Promise<Extract<FeedbackResultContext, { status: 'available' }>> {
  const source = observation.resultSource;
  if (!source || source.conversationId !== cid) throw new Error('feedback execution source unavailable');
  const result = await readGroupExecutionResult(userId, source);
  const injections = await listInjectionReceipts(userId, result.taskRunId);
  const injection = injections.find(row => row.assetId === observation.assetId && row.assetVersion === observation.assetVersion
    && row.status === 'dispatched' && row.dispatchBinding?.executionId === source.executionId
    && row.dispatchBinding?.actorId === source.actorId && row.dispatchBinding?.sourceMessageId === observation.messageId);
  if (!injection?.dispatchBinding || !await readDispatchBindingContext(userId, injection, { cid, taskRunId: result.taskRunId, messageId: result.anchorId }))
    throw new Error('feedback dispatch binding unavailable');
  const message = await readDispatchSourceMessage(userId, cid, injection.dispatchBinding.runId, observation.messageId);
  if (!message) throw new Error('feedback submitted message unavailable');
  const { readCognitionSourceControl } = await import('./source-control');
  const { cognitionMessageSourceId } = await import('./source-identity');
  const resultMessages = result.content.refs.filter(ref => ref.kind === 'message');
  const controls = await Promise.all([
    readCognitionSourceControl(userId, { kind: 'execution_evaluation', id: source.executionId }),
    readCognitionSourceControl(userId, { kind: 'conversation', id: cid }),
    readCognitionSourceControl(userId, { kind: 'conversation', id: cognitionMessageSourceId(cid, message.id) }),
    ...resultMessages.map(ref => readCognitionSourceControl(userId, { kind: 'conversation', id: cognitionMessageSourceId(cid, ref.id) })),
  ]);
  if (controls.some(control => control && control.availability !== 'active')) throw new Error('feedback source unavailable');
  const { read } = await import('../execution-records');
  const execution = await read(userId, source.executionId);
  const sourceRefs: CognitionSourceRef[] = [{ kind: 'execution_evaluation', taxonomyVersion: 2, subtype: 'execution',
    scope: 'conversation', id: source.executionId, sourceVersion: execution.updatedAt },
    ...resultMessages.map(ref => ({ kind: 'conversation' as const, taxonomyVersion: 2 as const, subtype: 'message' as const,
      scope: 'conversation' as const, id: cognitionMessageSourceId(cid, ref.id), locator: { conversationId: cid, messageId: ref.id },
      ...(ref.contentHash ? { sourceVersion: `sha256:${ref.contentHash}` } : {}) }))];
  return { status: 'available', ...result.content, sourceRefs,
    readContext: { ...injection.dispatchBinding.scope, taskText: message.text || '' },
    fingerprint: JSON.stringify([result.fingerprint, injection.dispatchBinding, message, controls, sourceRefs]) };
}

/** Called before prepared/promotion checkpoints; old message observations have
 * no new prerequisite. Current permissions govern new writes; advancing the
 * current asset version does not invalidate feedback about its historical body. */
export async function assertFeedbackResultContextsCurrent(userId: string, cid: string,
  observations: Array<NightlyFeedbackObservation & { resultContext?: FeedbackResultContext }>): Promise<void> {
  for (const observation of observations) {
    if (!observation.resultSource) continue;
    if (observation.resultContext?.status !== 'available') throw new Error('feedback execution context unavailable');
    const [current] = await readFeedbackVersionContext(userId, cid, [observation]);
    if (current.versionContext.status === 'unavailable' || current.resultContext?.status !== 'available')
      throw new Error('feedback source unavailable');
    if (current.resultContext.fingerprint !== observation.resultContext.fingerprint) throw new Error('feedback execution context changed');
  }
}

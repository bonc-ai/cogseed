import { genId12 } from '../../storage';
import { previewContextProjection, reviseContextProjection } from './context-projection';
import { buildProjectionCard, type RecallProjectionCard } from './projection-card';

export interface ProjectionCardMessage {
  id: string;
}

/**
 * Adapter boundary for posting a projection card into a host conversation.
 * Recall owns the card/projection workflow; the host owns message transport.
 */
export interface ProjectionCardMessagePort {
  send(input: {
    userId: string;
    cid: string;
    text: string;
    card: RecallProjectionCard;
  }): Promise<ProjectionCardMessage>;
}

export interface PostProjectionCardMessageInput {
  cid: string;
  projectionId: string;
}

export interface PreviewAndPostProjectionCardInput {
  cid: string;
  taskRunId: string;
  workspaceId?: string;
  purpose: string;
  taskText?: string;
  authorization?: 'user_confirmed' | 'workspace_policy' | 'not_required';
  expiresAt?: string;
}

export interface ReviseAndPostProjectionCardInput {
  cid: string;
  projectionId: string;
  purpose?: string;
  addAssetIds?: string[];
  removeAssetIds?: string[];
  decisionNote?: string;
}

export interface PostProjectionCardMessageResult {
  ok: true;
  msg: ProjectionCardMessage;
  card: RecallProjectionCard;
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

function cardMessageText(card: RecallProjectionCard): string {
  const included = Number(card.summary?.includedCount || card.includedAssetIds?.length || 0);
  const omitted = Number(card.summary?.omittedCount || card.omittedAssetRefs?.length || 0);
  const purpose = String(card.purpose || 'this task');
  return `Found ${included} reusable ability asset${plural(included)} for ${purpose}; omitted ${omitted}.`;
}

export async function postProjectionCardMessage(
  userId: string,
  input: PostProjectionCardMessageInput,
  port: ProjectionCardMessagePort,
): Promise<PostProjectionCardMessageResult> {
  const card = await buildProjectionCard(userId, input.projectionId);
  const msg = await port.send({
    userId,
    cid: input.cid,
    text: cardMessageText(card),
    card,
  });
  return { ok: true, msg, card };
}

export async function reviseAndPostProjectionCard(
  userId: string,
  input: ReviseAndPostProjectionCardInput,
  port: ProjectionCardMessagePort,
): Promise<PostProjectionCardMessageResult & { projection: Awaited<ReturnType<typeof reviseContextProjection>> }> {
  const revision = await reviseContextProjection(userId, input.projectionId, {
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(input.addAssetIds !== undefined ? { addAssetIds: input.addAssetIds } : {}),
    ...(input.removeAssetIds !== undefined ? { removeAssetIds: input.removeAssetIds } : {}),
    ...(input.decisionNote !== undefined ? { decisionNote: input.decisionNote } : {}),
  });
  const posted = await postProjectionCardMessage(userId, { cid: input.cid, projectionId: revision.id }, port);
  return { ...posted, projection: revision };
}

export async function previewAndPostProjectionCard(
  userId: string,
  input: PreviewAndPostProjectionCardInput,
  port: ProjectionCardMessagePort,
): Promise<PostProjectionCardMessageResult & { projection: Awaited<ReturnType<typeof previewContextProjection>> }> {
  const projection = await previewContextProjection(userId, {
    taskRunId: input.taskRunId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    purpose: input.purpose,
    ...(input.taskText ? { taskText: input.taskText } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  const posted = await postProjectionCardMessage(userId, { cid: input.cid, projectionId: projection.id }, port);
  return { ...posted, projection };
}

export interface PreviewAndPostNextTaskProjectionCardInput {
  cid: string;
  workspaceId?: string;
  purpose?: string;
  taskText?: string;
  authorization?: PreviewAndPostProjectionCardInput['authorization'];
  expiresAt?: string;
}

export async function previewAndPostProjectionCardForNextTask(
  userId: string,
  input: PreviewAndPostNextTaskProjectionCardInput,
  port: ProjectionCardMessagePort,
): Promise<PostProjectionCardMessageResult & { taskRunId: string; projection: Awaited<ReturnType<typeof previewContextProjection>> }> {
  const taskRunId = `rt-${genId12()}`;
  const projection = await previewContextProjection(userId, {
    taskRunId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    purpose: input.purpose || 'conversation_task',
    ...(input.taskText ? { taskText: input.taskText } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  const posted = await postProjectionCardMessage(userId, { cid: input.cid, projectionId: projection.id }, port);
  return { ...posted, taskRunId, projection };
}

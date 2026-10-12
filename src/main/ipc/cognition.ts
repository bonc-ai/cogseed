import * as cognition from '../features/cognition';
import { generateCognitionDraft } from '../features/cognition/capture-draft';
import { safeId } from '../storage';

interface IpcContext {
  userId: string;
}

type Payload = Record<string, unknown>;

function requiredId(value: unknown, field: string): string {
  if (!safeId(value) || typeof value !== 'string' || value.length > 160) {
    throw new Error(`invalid cognition ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid cognition ${field}`);
  return parsed;
}

function pageSize(value: unknown): number {
  const parsed = positiveInteger(value, 'page size', cognition.DEFAULT_COGNITION_PAGE_SIZE);
  if (parsed > cognition.MAX_COGNITION_PAGE_SIZE) throw new Error('invalid cognition page size');
  return parsed;
}

// 旧版 CognitionAsset 的全部自有入口（list/get/create/evidence.add/confirm/
// defer/reuse/capture）已下线：list 由 ipc/index.ts 以能力资产语义注册；
// 正式候选生产者走 recall.candidates.save 主链；遗留 store 只保留读用途
// （renderer 分页 + memory 可见性门控）。
export const invokeHandlers = {
  'cognition.capture.draft': async (payload: Payload, ctx: IpcContext) => {
    const conversationId = requiredId(payload.conversationId, 'conversation id');
    const messageId = requiredId(payload.messageId, 'message id');
    return generateCognitionDraft(ctx.userId, { conversationId, messageId });
  },

  'cognition.assets.page': async (payload: Payload, ctx: IpcContext) => ({
    page: await cognition.listCognitionAssetPage(
      ctx.userId,
      positiveInteger(payload.page, 'page', 1),
      pageSize(payload.pageSize),
    ),
  }),
};

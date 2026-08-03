import * as cognition from '../features/cognition';
import type {
  CognitionEvidenceInput,
  CognitionEvidenceKind,
} from '../features/cognition';
import { safeId } from '../storage';

interface IpcContext {
  userId: string;
}

type Payload = Record<string, unknown>;

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing cognition ${field}`);
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!safeId(value)) throw new Error(`invalid cognition ${field}`);
  return value as string;
}

function assetId(payload: Payload): string {
  if (!safeId(payload.assetId)) throw new Error('invalid cognition asset id');
  return payload.assetId as string;
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

function evidenceKind(value: unknown): CognitionEvidenceKind {
  if (value !== 'conversation' && value !== 'project' && value !== 'execution' && value !== 'manual') {
    throw new Error('invalid cognition evidence kind');
  }
  return value;
}

function evidenceInput(value: unknown): CognitionEvidenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('missing cognition evidence');
  }
  const payload = value as Payload;
  const result: CognitionEvidenceInput = {
    kind: evidenceKind(payload.kind),
    summary: requireText(payload.summary, 'evidence summary'),
    sourceLabel: requireText(payload.sourceLabel, 'evidence sourceLabel'),
  };
  const conversationId = optionalId(payload.conversationId, 'evidence conversationId');
  const projectId = optionalId(payload.projectId, 'evidence projectId');
  if (conversationId) result.conversationId = conversationId;
  if (projectId) result.projectId = projectId;
  return result;
}

function reuseInput(payload: Payload): cognition.CognitionReuseInput {
  const conversationId = optionalId(payload.conversationId, 'reuse conversationId');
  const projectId = optionalId(payload.projectId, 'reuse projectId');
  return {
    sourceLabel: requireText(payload.sourceLabel, 'reuse sourceLabel'),
    ...(conversationId ? { conversationId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

export const invokeHandlers = {
  'cognition.assets.list': async (_payload: Payload, ctx: IpcContext) => ({
    assets: await cognition.listCognitionAssets(ctx.userId),
  }),

  'cognition.assets.page': async (payload: Payload, ctx: IpcContext) => ({
    page: await cognition.listCognitionAssetPage(
      ctx.userId,
      positiveInteger(payload.page, 'page', 1),
      pageSize(payload.pageSize),
    ),
  }),

  'cognition.assets.get': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.getCognitionAsset(ctx.userId, assetId(payload)),
  }),

  'cognition.assets.create': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.createCognitionAsset(ctx.userId, {
      title: requireText(payload.title, 'title'),
      summary: requireText(payload.summary, 'summary'),
    }),
  }),

  'cognition.assets.capture': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.createCognitionAssetWithEvidence(ctx.userId, {
      title: requireText(payload.title, 'title'),
      summary: requireText(payload.summary, 'summary'),
      evidence: evidenceInput(payload.evidence),
    }),
  }),

  'cognition.assets.evidence.add': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.addCognitionEvidence(ctx.userId, assetId(payload), evidenceInput(payload)),
  }),

  'cognition.assets.confirm': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.confirmCognitionAsset(ctx.userId, assetId(payload)),
  }),

  'cognition.assets.defer': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.deferCognitionAsset(ctx.userId, assetId(payload)),
  }),

  'cognition.assets.reuse': async (payload: Payload, ctx: IpcContext) => ({
    asset: await cognition.recordCognitionReuse(ctx.userId, assetId(payload), reuseInput(payload)),
  }),
};

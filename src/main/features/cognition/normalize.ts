import type { CognitionAssetType, CognitionCandidateAction, CognitionRelationRef } from './types';

export function compactRefs(refs: Array<string | undefined | null>): string[] {
  return Array.from(new Set(refs.map((ref) => String(ref || '').trim()).filter(Boolean)));
}

export function titleFromText(text: string | undefined | null, fallback: string): string {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}…`;
}

export function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = Number(limit || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

export function assetRef(type: CognitionAssetType, id: string): string {
  return `${type}:${id}`;
}

export function relationRef(type: CognitionRelationRef['type'], id: string, title?: string): CognitionRelationRef {
  return { type, id, title };
}

export function actionsForCandidate(source: string, status: string): CognitionCandidateAction[] {
  if (source === 'personal_ontology') return ['open_personal_ontology', 'import_to_recall'];
  // 四操作（PRD §5.6 候选卡：保存/修改后保存/暂缓/拒绝）+ deep_review。
  // deep_review 保留自本分支的沉淀候选准入门：它是查看安全审核结果的入口，
  // 去掉它等于让审核结论无处可看。
  if (status === 'pending') return ['source', 'deep_review', 'accept', 'modify', 'defer', 'reject'];
  return ['source'];
}

export function refMatchesAsset(ref: string, assetType: CognitionAssetType | 'skill', assetId: string): boolean {
  const normalized = String(ref || '').trim();
  if (!normalized) return false;
  const candidates = new Set([
    `${assetType}:${assetId}`,
    `${assetType}://${assetId}`,
    `asset:${assetType}:${assetId}`,
    `asset://${assetType}/${assetId}`,
  ]);
  if (assetType === 'skill') {
    candidates.add(`custom_skill:${assetId}`);
    candidates.add(`custom_skill://${assetId}`);
  }
  return candidates.has(normalized) || normalized.endsWith(`/${assetId}`) || normalized.endsWith(`:${assetId}`);
}

import { parseAbilityAssetReference } from '../recall/asset-reference';
import type { CognitionAssetType, CognitionCandidateAction, CognitionRelationRef } from './types';

export function titleFromText(text: string | undefined | null, fallback: string): string {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= 80) return trimmed;
  // slice 按 UTF-16 码元截断可能劈开代理对（emoji 等），末尾留下孤立高代理：
  // 它落盘 JSON 后经 UTF-8 往返会变 U+FFFD。孤立代理必在末尾，砍 1 码元即愈；
  // 80 语义不变（按码元封顶，不按码点翻倍）。同型先例：semantic-review.ts、
  // sanitizePoText（po/model.ts）。
  const head = trimmed.slice(0, 80);
  const last = head.charCodeAt(head.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head}…`;
}

export function relationRef(type: CognitionRelationRef['type'], id: string, title?: string): CognitionRelationRef {
  return { type, id, title };
}

// P-r1-17：actionsForCandidate 的非本体源分支不可达（唯一调用方 mapPersonal
// 恒传 'personal_ontology'），status 分支随之死——六个动作值零生产零消费，
// 分支已删，函数退化为常量。
export const personalOntologyCandidateActions: readonly CognitionCandidateAction[] = [
  'open_personal_ontology', 'import_to_recall',
];

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
  if (candidates.has(normalized)) return true;
  // P-r1-3：复用回执侧持久化的 ref 方言（asset-reference.ts 的四种：
  // 裸 id / asset:id / asset:id@v2 / asset:id@v2:reason）此前在这里全失配，
  // 复用计数对真实回执恒 0。复用同一解析器，不另写一套方言。
  const parsed = parseAbilityAssetReference(normalized);
  if (parsed && parsed.assetId === assetId) return true;
  // 带命名空间的兜底只认 asset: scheme——原来的裸 endsWith 对任意前缀
  // （如 "evil:<id>"）都成立，属于误配面，收窄到已知 scheme。
  return normalized.startsWith('asset:')
    && (normalized.endsWith(`/${assetId}`) || normalized.endsWith(`:${assetId}`));
}

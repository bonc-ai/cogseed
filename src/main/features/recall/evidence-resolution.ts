import { createLogger } from '../../logger';
import { sourceTaskBoundary } from './scope-policy';
import type { CognitionSourceRef } from './source-service';

const log = createLogger('recall.evidence-resolution');

/** 复盘记录查无时的标记原因（写进 ref.reason，供界面/审计辨认）。 */
export const KSTAR_EPISODE_MISSING = 'kstar_episode_missing';

/** 是否"长得像 KSTAR 复盘证据"：与渲染层归边判据同一形状口径
 *  （kind=execution 且 id 前缀 kse-）。 */
function isKstarEpisodeRef(ref: CognitionSourceRef): boolean {
  return String(ref.kind || '') === 'execution' && String(ref.id || '').startsWith('kse-');
}

/** Recover a boundary only from reachable KStar evidence owned by this user.
 *  Unlinked origins must agree on the task before it can be restored. */
export async function readKstarScopeEvidence(
  userId: string, refs: readonly CognitionSourceRef[], episodeId?: string,
): Promise<string | undefined> {
  const candidates = refs.filter(ref => isKstarEpisodeRef(ref) && (!episodeId || ref.id === episodeId));
  if (!candidates.length) return undefined;
  const { readKstarEpisode } = await import('../kstar/episode-store');
  const { isCognitionSourceEnabled } = await import('./source-control');
  const goals = new Set<string>();
  for (const ref of candidates) {
    if (ref.degraded || !await isCognitionSourceEnabled(userId, ref)) return undefined;
    const episode = await readKstarEpisode(userId, ref.id);
    const boundary = episode && sourceTaskBoundary(episode.t.userGoal);
    if (!boundary) return undefined;
    goals.add(boundary);
  }
  return goals.size === 1 ? goals.values().next().value : undefined;
}

/**
 * 执行类证据的可解析性标记（2026-09-18，乙档口径：写入照常，解析不到的
 * 标不可用，不阻断、不丢数据）。
 *
 * 背景：候选确认写入前只校验 ref 的格式，不校验它指向的 KSTAR 复盘记录
 * 是否真实存在——验收时造出来的 id 也能当血统写进资产版本快照；复盘记录
 * 事后被清理时更会留下悬空引用。这里在写入口把"查无此记录"如实标成
 * `degraded` + reason，渲染层据此显示「来源记录不可用」，并把它排除出
 * KSTAR 归边（查无的引用不能当出身）。
 *
 * 边界（诚实态的两条底线）：
 *  - 只处理 kind=execution 且 id 前缀 kse- 的证据；其他来源的可解析性由
 *    source-catalog 的既有链路负责。
 *  - 读取失败（目录 IO / 记录解析出错）不标记：读不到 ≠ 不存在，宁可保持
 *    原样，也不把"暂时读不出来"写成"记录不存在"。
 */
export async function resolveExecutionEvidenceRefs(
  userId: string,
  refs: readonly CognitionSourceRef[] | undefined,
): Promise<CognitionSourceRef[] | undefined> {
  if (!refs) return undefined;
  if (!refs.length) return [];
  const targets = refs.filter((ref) => isKstarEpisodeRef(ref) && ref.degraded !== true);
  if (!targets.length) return [...refs];
  let readKstarEpisode: typeof import('../kstar/episode-store').readKstarEpisode;
  try {
    // 动态 import 避免 recall → kstar 的静态依赖环（照 candidate-service 既有写法）。
    ({ readKstarEpisode } = await import('../kstar/episode-store'));
  } catch (error) {
    log.warn('kstar episode store unavailable; execution evidence left unmarked', { error: String(error) });
    return [...refs];
  }
  const missing = new Set<string>();
  for (const refId of [...new Set(targets.map((ref) => String(ref.id)))]) {
    try {
      const episode = await readKstarEpisode(userId, refId);
      if (!episode) missing.add(refId);
    } catch (error) {
      // 记录损坏等读取失败：不当作"不存在"，原样放行。
      log.warn('kstar episode read failed; evidence left unmarked', { episodeId: refId, error: String(error) });
    }
  }
  if (!missing.size) return [...refs];
  return refs.map((ref) => (isKstarEpisodeRef(ref) && ref.degraded !== true && missing.has(String(ref.id))
    ? { ...ref, degraded: true as const, reason: KSTAR_EPISODE_MISSING }
    : ref));
}

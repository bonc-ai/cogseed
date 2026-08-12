/** 把本体抽取技能产出的候选，导入统一认知候选池。
 *
 *  **为什么需要这层。** 认知候选目前有两个真实产出面：一是 Recall 侧的五条链
 *  （capture / KSTAR / session import / teaching / evidence adapter），它们直接写
 *  统一池；二是技能 `personal-ontology-candidate-builder`，它按自己的契约写
 *  `<uid>/local/ontology_candidates/candidates.md`。后者此前只能靠用户在界面上
 *  逐条点「导入」，不点就永远滞留在自己的文件里——同一个产品因此看起来有两个
 *  候选池，其实只是少了一跳。
 *
 *  **这层不做什么，比做什么更重要：**
 *
 *  - **不改技能契约**。SKILL.md 与 schemas.json 里写死了输出路径，改它影响的是
 *    技能侧。技能继续写自己的文件，这里只负责把新的那些搬进统一池。
 *  - **不删也不改 `candidates.md`**。它仍然是可读的兼容来源，历史候选不丢。
 *    搬运是「复制进统一池」，不是「迁走」。
 *  - **不自造去重**。`saveRecallCandidate` 已按 `judgment + sourceRefs` 指纹去重，
 *    命中即返回已有那条。这层反复跑不会长出第二条候选——幂等性来自那里，
 *    不来自这里另记一份已处理清单（那种清单本身会变成第三个真相源）。
 *  - **不放宽证据门槛**。没有 `source_memory_refs` 的条目直接跳过，不给它编一个
 *    来源。技能的 SKILL.md 本就要求每条必须带来源；缺了说明那条候选有问题，
 *    应该在技能侧修，而不是在这里补一个假证据混进正式链路。
 */

import { createLogger } from '../../logger';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import { importPersonalOntologyCandidate, listRecallCandidates } from './candidate-service';

const log = createLogger('recall.ontology-bridge');

/** 单次最多搬多少条。技能一次产出通常个位数；设上限是防止某次异常产出把
 *  统一池灌满，而不是分页——超出的下次调用继续搬。 */
const MAX_PER_SYNC = 50;

export interface OntologyCandidateSyncResult {
  /** 本次真正新建的统一候选数。 */
  imported: number;
  /** 指纹命中已有候选、未新建的条数。幂等生效时这个数会增长。 */
  alreadyPresent: number;
  /** 缺来源引用被跳过的条数。 */
  skippedNoEvidence: number;
  /** 导入过程中出错的条数（单条失败不影响其余）。 */
  failed: number;
}

/**
 * 把 `candidates.md` 里尚未进入统一池的候选搬进来。
 *
 * 可以反复调用：已在池中的会被指纹命中而不重复新建。返回的计数用来向用户
 * 交代「这次搬了几条、几条本来就有、几条因为缺来源没搬」——沉默地少搬几条
 * 比报错更难排查。
 */
export async function syncOntologyCandidatesIntoPool(
  userId: string,
): Promise<OntologyCandidateSyncResult> {
  const result: OntologyCandidateSyncResult = {
    imported: 0, alreadyPresent: 0, skippedNoEvidence: 0, failed: 0,
  };

  let pending: Array<{ candidate_id: string; source_memory_refs?: string[] }>;
  try {
    const data = await personalOntologyCandidates.listCandidates(userId);
    pending = (data.candidate_updates || []) as typeof pending;
  } catch (error) {
    // 文件不存在是正常情况（技能还没跑过），不该报错。
    log.warn('ontology candidate ledger unreadable', { error: (error as Error).message });
    return result;
  }
  if (!pending.length) return result;

  // 先取一次统一池的现状，用来区分「新建」与「本来就有」。
  // saveRecallCandidate 两种情况都返回记录，光看返回值分不出来。
  let knownIds: Set<string>;
  try {
    knownIds = new Set((await listRecallCandidates(userId)).map((candidate) => candidate.id));
  } catch (error) {
    log.warn('unified pool unreadable, skipping ontology sync', { error: (error as Error).message });
    return result;
  }

  for (const entry of pending.slice(0, MAX_PER_SYNC)) {
    if (!entry?.candidate_id) continue;
    // 缺来源的不搬——不给它编一个证据。
    if (!Array.isArray(entry.source_memory_refs) || !entry.source_memory_refs.length) {
      result.skippedNoEvidence++;
      continue;
    }
    try {
      const candidate = await importPersonalOntologyCandidate(userId, entry.candidate_id);
      if (knownIds.has(candidate.id)) result.alreadyPresent++;
      else { result.imported++; knownIds.add(candidate.id); }
    } catch (error) {
      // 单条失败不影响其余：一条格式坏掉的候选不该挡住整批。
      result.failed++;
      log.warn('ontology candidate import failed', {
        candidateId: entry.candidate_id, error: (error as Error).message,
      });
    }
  }

  if (result.imported || result.failed) {
    log.info('ontology candidates synced into unified pool', { ...result });
  }
  return result;
}

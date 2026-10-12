/**
 * experience-catalog-hint.ts — 经验清单接入提示词（specs/016 T008 / research D7）。
 *
 * 形态平行于 asset-catalog-hint.ts（目录直接放进模型眼前，省一次工具往返；
 * 大目录内联截断），但**与资产目录互不合并**——两段目录各自的过滤口径与
 * 集合边界不同，合并就是"经验稀释资产"的回归。每轮按运行上下文重建，避免
 * 跨 Agent/workspace 复用过期目录。
 *
 * 构建时对「已挂载但本轮被准入拦下」的经验各写一条 omitted 回执
 *（channel='experience'，reason=准入理由码）——被拦不静默（FR-005），
 *回执只存 id/版本/理由码，正文与原因码原文都不落。
 */

import { createLogger } from '../../logger';
import { logErrorRef, maskId } from '../../util/log-redact';
import { buildExperienceCatalog } from './experience-catalog';

const log = createLogger('recall.experience-catalog-hint');

/** 常驻提示词的清单上限（同资产量级：30 × 单行 ≈ 数 KB，超限截前 20 行）。 */
export const INLINE_EXPERIENCE_CATALOG_MAX_ENTRIES = 30;
/** 超限内联时的保留行数（资产 hint 同款：留一行"还有 N 条"引导翻页）。 */
const INLINE_OVERFLOW_KEEP = 20;

export function resetExperienceCatalogHintCacheForTest(): void {
  // Retained for compatibility; eligibility-sensitive text is not cached.
}

/** 本轮已挂载的经验集（@ 带入 / 引用）：taskRunId 是 omitted 回执的归属轮次。 */
export interface ExperienceCatalogMounted {
  /** 关联轮次；bus 装配点拿不到稳定 runId 时可省（omitted 回执
   *  的 taskRunId 字段随之省略，84 行调用处已按可选消费）。 */
  taskRunId?: string;
  experienceIds: readonly string[];
}

/**
 * 经验清单的提示词文本；读不到或没有可入清单的经验时返回空串——**不输出
 *「0 条」**（那会让模型以为用户没有经验，资产 hint 同款口径）。装配点
 *（系统提示拼装处）由接线任务挂载，
 * 本函数只负责产出文本与被拦回执。
 */
export interface ExperienceCatalogPromptContext {
  agentId?: string;
  workspaceId?: string;
}

export async function experienceCatalogForPrompt(
  userId: string,
  cid = '',
  now = Date.now(),
  taskText = '',
  mounted?: ExperienceCatalogMounted,
  context: ExperienceCatalogPromptContext = {},
): Promise<string> {
  void cid;
  void now;
  try {
    const built = await buildExperienceCatalog(userId, taskText, {
      runtimeContext: {
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      },
      mountedExperienceIds: mounted?.experienceIds,
    });
    let text = built.text;
    if (built.entries.length > INLINE_EXPERIENCE_CATALOG_MAX_ENTRIES) {
      // 大目录：内联前 20 行 + 一行翻页引导；★（当轮相关）已排在前面，
      // 截断不会把相关条目挤出去。
      const more = built.entries.length - INLINE_OVERFLOW_KEEP;
      text = [
        ...built.lines.slice(0, INLINE_OVERFLOW_KEEP),
        `…还有 ${more} 条：可用 list_task_experiences 翻页查看。`,
      ].join('\n');
    }

    // 被拦的已挂载经验：各写恰好一条 omitted（recordInjectionReceipt 的幂等键
    // 含 taskRunId+条目+版本+状态，同轮重复调用返回同一条，不会刷屏）。
    // 回执失败不炸清单——清单是主产物，留痕失败只降级为日志可见。
    if (mounted?.taskRunId && built.omitted.length) {
      const { recordInjectionReceipt } = await import('./injection-receipt');
      for (const item of built.omitted) {
        try {
          await recordInjectionReceipt(userId, {
            taskRunId: mounted.taskRunId,
            assetId: item.id,
            assetVersion: item.version || 'unknown',
            boundary: 'real',
            status: 'omitted',
            channel: 'experience',
            ...(item.reason ? { reason: item.reason } : {}),
          });
        } catch (error) {
          log.warn('experience omission receipt failed', { userId: maskId(userId), experienceId: maskId(item.id), error: logErrorRef(error as Error) });
        }
      }
    }
    return text;
  } catch (error) {
    // 读不到就什么都不加（与资产 hint 同口径：不编造「0 条」）。
    log.warn('experience catalog prompt unavailable', { userId: maskId(userId), error: logErrorRef(error as Error) });
    return '';
  }
}

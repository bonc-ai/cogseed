import { createLogger } from '../../logger';
import { addEntryTransactional } from '../memory';
import type { KstarReviewRecord } from './types';

const log = createLogger('kstar.personal-profile');

/**
 * KStar → USER.md 个人画像同步（2026-08-17 方案 B）。
 *
 * 背景：spec(3) 的「关于我」（personal）通道在 KStar 线是断的——gapType 只在
 * attribution=knowledge_gap 时返回 personal，成功任务的偏好（"我以后的周报
 * 都要按这个格式"）被落成 rule。而 USER.md（用户画像）通道已存在：每次投影
 * 都作为 ontology 资产（type=personal）注入。
 *
 * 方案：review 推理模型提名 lessonPersonal=true 时，宿主做确定性校验（用户
 * 消息含长期偏好证据），通过则写入 USER.md（复用 memory 通道，自带精确去重
 * 与注入防护）。用户可在记忆页随时删改——真实控制权。
 *
 * 为什么写 USER.md 而不是产 personal 资产候选：
 *  - 复用现有注入链路（ontology 每次投影自动加载），无类型冲突/无候选堆积
 *  - USER.md 是用户显式管理的画像，删改即控（隐私边界）
 *  - 注入语义明确：ontology 是"用户画像上下文"，不是可执行规则
 */

/** 长期偏好证据（用户原话层，确定性）——"我以后都/我的习惯/我偏好/我是…"。
 *  与 capture 线 STABLE_PREFERENCE_PATTERN 互补但更宽，覆盖周报场景的真实
 *  说法（"我以后的周报都要按这个格式"——不含"喜欢/偏好"字样）。 */
const LONG_TERM_EVIDENCE = /(?:我以后的?[^，。！？]{0,12}(?:都要|都用|都按|都|要|就|会)|我以后(?:都|要|就|会)|以后(?:都|要|就|会)|我的[^，。！？]{0,14}(?:都要|习惯|偏好|风格|身份|角色)|我(?:的)?(?:风格|习惯|偏好|身份|角色|长期|一直|向来|通常|总是|每次都)|我(?:是|担任|负责)[^，。！？]{0,20}(?:团队|负责人|主管|经理|工程师|开发|设计|财务|运营)|我希望(?:以后|今后|未来|每次)|我喜欢|我不喜欢)/;

/** 项目事实/一次性请求（防误判）——"今天/本周/这次/帮我…" */
const ONE_OFF_OR_PROJECT_FACT = /(?:今天|今日|昨天|明天|本周|这周|下周|本月|这次|本次|当前|目前|正在|眼下|帮我|请帮我|麻烦你|截止|deadline|会议|日程)/;

/** 确定性校验：模型提名 personal 且用户消息含长期偏好证据，且不是一次性
 *  请求/项目事实。返回 true 才写入 USER.md。
 *
 *  注意：ONE_OFF_OR_PROJECT_FACT 只检查**用户消息**（判断请求是否一次性），
 *  不检查 lesson——lesson 里的"本周完成/本周上线"可能是模板段落名（"本周
 *  完成"是周报模板的一节），不是项目事实，误伤会拦掉真实偏好。 */
export function personalLessonEligible(
  review: KstarReviewRecord,
  userMessages: ReadonlyArray<{ text?: string }>,
): boolean {
  if (review.lessonPersonal !== true) return false;
  if (!review.lesson?.trim()) return false;
  // 用户消息：长期偏好证据命中，且不是一次性请求/项目事实。
  const durableUserEvidence = userMessages.some((m) => {
    const text = String(m.text || '');
    return LONG_TERM_EVIDENCE.test(text) && !ONE_OFF_OR_PROJECT_FACT.test(text);
  });
  if (durableUserEvidence) return true;
  // 兜底：用户消息不可用/被截断时，lesson 自身含长期偏好措辞也算。
  // （lesson 不做 ONE_OFF 过滤——模板段落名含"本周"是正常的。）
  return LONG_TERM_EVIDENCE.test(review.lesson);
}

/** 写入 USER.md。复用 memory 通道：自带精确去重（同文本已存在 → no-op）、
 *  注入防护（scanForInjection）、记录元数据。失败不阻断闭环。 */
export async function syncPersonalLessonToProfile(
  userId: string,
  review: KstarReviewRecord,
  userMessages: ReadonlyArray<{ text?: string }>,
): Promise<boolean> {
  if (!personalLessonEligible(review, userMessages)) return false;
  try {
    const content = String(review.lesson || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!content) return false;
    const result = await addEntryTransactional(userId, 'user', content);
    if (result.ok) {
      log.info('kstar personal lesson synced to user profile', {
        userId,
        episodeId: review.episodeId,
        lessonPreview: content.slice(0, 60),
      });
    } else if (result.error) {
      log.warn('kstar personal lesson sync skipped', {
        userId,
        episodeId: review.episodeId,
        reason: result.error,
      });
    }
    return result.ok;
  } catch (error) {
    log.warn('kstar personal lesson sync degraded', {
      userId,
      episodeId: review.episodeId,
      error: (error as Error).message,
    });
    return false;
  }
}

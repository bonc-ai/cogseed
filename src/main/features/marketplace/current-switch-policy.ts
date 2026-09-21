/**
 * M1 的**唯一**决策点 —— current install 的切换时机。
 *
 * ## 取值（2026-09-20 已收口）
 *
 * - `defer-while-pinned` —— **当前取值**。有进行中的使用（非终态 Task 钉固该内容）时不推进
 *   current install，等使用结束后再替换；**下载与校验可以先做完**。
 * - `immediate` —— 并列实现，立即推进；运行中的使用靠版本副本仍读旧版本。
 *
 * **收口依据**：冻结 PRD `doc-v0.5` §7.5 字面——「**使用中延后替换**：该 Skill 有进行中的
 * 使用时不替换，等所有进行中的使用结束后再落盘；**下载与校验可以先做完**」。
 * 采用该取值即**回到冻结契约**，不构成对它的修改，故不需要 Change Candidate。
 *
 * ## ⚠️ 取值已定，但不得扩散
 *
 * 下列七个组件**不得感知**本取值：下载 / 校验 / 临时区 / 原子提升 / 版本副本写入 /
 * pin 产生与解析 / 停用判定与回收。SC-010 的判据是**翻转取值后这七处改动 0 行**。
 * 理由不再是「等 Owner 裁决」，而是**结构性质量**：切换时机是这套设计里唯一的时序选择，
 * 把它留在单点意味着它永远可被重新裁决。
 *
 * 契约：specs/010 `contracts/current-switch-policy.md`｜需求：FR-037、SC-010
 */

import { createLogger } from '../../logger';
import { hasActivePinsForContent } from './pin-scan';

const log = createLogger('marketplace/current-switch-policy');

export type CurrentSwitchPolicyValue = 'immediate' | 'defer-while-pinned';

/**
 * 当前取值。**翻转它是本模块唯一需要改的地方**——其余组件读不到这个常量。
 */
export const CURRENT_SWITCH_POLICY: CurrentSwitchPolicyValue = 'defer-while-pinned';

export interface CurrentSwitchDecision {
  /** 是否可以把 current install 推进到新版本。 */
  advance: boolean;
  reason:
    /** 取值为 immediate：不看使用状态，直接推进。 */
    | 'policy-immediate'
    /** 没有进行中的使用，可以推进。 */
    | 'no-active-use'
    /** 有进行中的使用 → 推迟，等使用结束后的下一轮再替换。 */
    | 'deferred-active-use';
}

/**
 * 决定「现在能不能把 current install 推进到新版本」。
 *
 * 调用点**恰一次**：在版本副本写入完成之后、推进 current install 之前。
 * 「进行中的使用」复用 `pin-scan.ts` 的**唯一一份扫描**——不新建登记表、
 * 不维护与 pin 平行的 active-use 状态。
 *
 * ⚠️ 扫描不可信时 `hasActivePinsForContent` 返回 `true`（拿不准就当它在用），
 * 因此本函数在该情形下**推迟而不是推进**——保守侧是「不替换」。
 */
export async function decideCurrentSwitch(
  userId: string,
  contentId: string,
  policy: CurrentSwitchPolicyValue = CURRENT_SWITCH_POLICY,
): Promise<CurrentSwitchDecision> {
  if (policy === 'immediate') {
    return { advance: true, reason: 'policy-immediate' };
  }
  const inUse = await hasActivePinsForContent(userId, contentId);
  if (inUse) {
    log.info('current install switch deferred: the content is in active use', { contentId });
    return { advance: false, reason: 'deferred-active-use' };
  }
  return { advance: true, reason: 'no-active-use' };
}

/**
 * 产物登记广播 —— 「模型声明本轮产出了哪些文件」这件事的唯一对外出口。
 *
 * 为什么需要它（现状调查结论，见 specs/009-meeting-output-archive/verification-evidence.md）：
 *   - 智能会议Agent 的工作流明确要求"用 `publish_outputs` 登记本轮实际写成功的文件"，
 *     所以**每一次出纪要都必然经过产物登记** —— 这是唯一与 Agent/技能实现无关的稳定收口点；
 *   - 但宿主里产物登记的落地函数（`group_chat/bus.ts::onOutputsPublished`）**不通知任何外部模块**；
 *   - 仓库里本有一个 `produced_output_hooks.ts` 承载同类意图，可它的四个导出函数
 *     **在整个 src/main 里 0 处引用** —— 机制是死的，从没接线。
 *
 * 因此本模块提供一条**极窄**的旁路：登记成功后广播"哪些文件被接受"，由外部观察者决定做什么。
 *
 * 设计约束：
 *   1. **单向、无回传**。观察者不能影响登记结果，也不能抛错影响会话（`bus.ts` 是会话主链路）。
 *   2. **不做去重、不做业务判断**。这里只广播事实；幂等、去重、目标判定都归观察者。
 *   3. **不 import `group_chat/bus`**。依赖方向是 bus → 本模块，反过来会成环。
 *   4. 观察者集合挂 `globalThis`，避开本仓库"同模块被 ESM/CJS 各加载一次"的既有陷阱
 *      （`group_chat/bus.ts` 与 `meeting_stage_events.ts` 都用了同一手法）。
 */

import { createLogger } from '../logger';

const log = createLogger('produced-outputs-bus');

export interface ProducedOutputsEvent {
  /** 用户标识（不透明路径段）。 */
  uid: string;
  /** 会话标识（用于后续目标判定与兜底关联）。 */
  conversationId: string;
  /** **已通过校验**的产物绝对路径（本轮写过 + 文件真实存在）。 */
  acceptedAbsPaths: readonly string[];
}

export type ProducedOutputsObserver = (event: ProducedOutputsEvent) => void;

const OBSERVERS_KEY = Symbol.for('cogseed.producedOutputs.observers');

function observers(): Set<ProducedOutputsObserver> {
  const g = globalThis as unknown as Record<symbol, Set<ProducedOutputsObserver> | undefined>;
  let s = g[OBSERVERS_KEY];
  if (!s) { s = new Set(); g[OBSERVERS_KEY] = s; }
  return s;
}

/** 订阅产物登记事件。返回退订函数（幂等）。 */
export function subscribeProducedOutputs(observer: ProducedOutputsObserver): () => void {
  const set = observers();
  set.add(observer);
  return () => { set.delete(observer); };
}

/** 当前观察者数量（供测试与诊断）。 */
export function producedOutputsObserverCount(): number {
  return observers().size;
}

/**
 * 广播一次产物登记。**永不抛异常** —— 观察者出错绝不能影响会话主链路。
 *
 * 由 `group_chat/bus.ts::onOutputsPublished` 在接受列表非空时调用。
 * 调用方只应在**登记结果已确定**之后调用（accepted 已算完），不得用于影响登记本身。
 */
export function emitProducedOutputs(event: ProducedOutputsEvent): void {
  if (!event || !event.uid || !Array.isArray(event.acceptedAbsPaths) || event.acceptedAbsPaths.length === 0) {
    return;
  }
  const frozen: ProducedOutputsEvent = Object.freeze({
    uid: event.uid,
    conversationId: event.conversationId,
    acceptedAbsPaths: Object.freeze([...event.acceptedAbsPaths]),
  });
  for (const observer of [...observers()]) {
    try {
      observer(frozen);
    } catch (err) {
      log.warn('produced outputs observer threw', { error: (err as Error)?.message });
    }
  }
}

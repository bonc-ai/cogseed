/**
 * store-events — 认知资产数据变更广播（2026-09-27 破坏性重构：刷新机制重写）
 *
 * 事件源挂在唯一持久化汇点（recall/store.ts 的写函数），不在各 service 的
 * 业务函数里撒埋点——不管写入来自渲染层操作、后台整理推进、夜间沉淀还是
 * 本体反哺，最终都过 store，一处挂点结构性覆盖全部写入。
 *
 * 协议（channel: `cognition:changed`，见 preload 白名单 `cognition:` 前缀）：
 *   { collection, generation, op?, recordId? }
 *   - collection：store 的 collection 名（ability-assets / candidates / …），
 *     **不做主进程侧的域归并**——渲染层自己声明"哪个区块监听哪些 collection"，
 *     主进程不持有界面分区的知识。
 *   - generation：每 (userId, collection) 的写入序号（内存）。50ms 合并窗口
 *     内会只广播最后一个序号，所以跳号可能只是多次写合成一次通知；渲染层
 *     不用它推断丢包。它目前保留作诊断线索，重启后归零不影响读取。
 *   - op / recordId：调试线索，合并窗口内取最后一次；渲染层不得依赖它们
 *     做正确性判断（重拉才是正确性来源）。
 *
 * 合并窗口：同一 (userId, collection) 50ms 内的多次写入合并成一条广播——
 * 整理抽取这类高频 append 不该变成事件风暴（流式通道的 16ms 批量同思路）。
 * 广播只在写**成功**后排队；写失败不发（界面显示旧值 + 错误，不显示假新值）。
 *
 * 未注册广播器（单测环境 / 主进程未完成 register）时静默丢弃，不报错——
 * notifier 的存在不能成为 store 写路径的新故障点。
 */

import { createLogger } from '../../logger';

const log = createLogger('recall-store-events');

/** 同 (userId, collection) 的合并窗口。 */
const MERGE_WINDOW_MS = 50;

export interface CognitionChangeNotice {
  collection: string;
  generation: number;
  op?: 'write' | 'update' | 'append' | 'remove';
  recordId?: string;
}

type Broadcaster = (notice: CognitionChangeNotice) => void;

let broadcaster: Broadcaster | null = null;

/** generation 计数器：`userId\x1fcollection` → 最近发出的代数。 */
const generations = new Map<string, number>();
/** 合并窗口挂起的定时器：`userId\x1fcollection` → Timeout。 */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 窗口内待发的最后一份载荷（合并语义：保留最后 op/recordId，generation 取最新）。 */
const pendingNotices = new Map<string, CognitionChangeNotice>();

export function setCognitionChangeBroadcaster(fn: Broadcaster | null): void {
  broadcaster = typeof fn === 'function' ? fn : null;
}

/**
 * 记一次写入并（在合并窗口后）广播。op/recordId 可省——removeRecallJsonlRecords
 * 这类按谓词批量删的调用方给不出 recordId，载荷仍要发（区块得刷新）。
 */
export function notifyCognitionWrite(
  userId: string,
  collection: string,
  op: CognitionChangeNotice['op'],
  recordId?: string,
): void {
  if (!broadcaster || typeof userId !== 'string' || !userId || typeof collection !== 'string' || !collection) return;
  const key = `${userId}\x1f${collection}`;
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  pendingNotices.set(key, { collection, generation, ...(op ? { op } : {}), ...(recordId ? { recordId } : {}) });
  if (!pendingTimers.has(key)) {
    pendingTimers.set(key, setTimeout(() => {
      pendingTimers.delete(key);
      const notice = pendingNotices.get(key);
      pendingNotices.delete(key);
      if (!notice || !broadcaster) return;
      try {
        broadcaster(notice);
      } catch (error) {
        // 广播失败不影响写路径；下一条写入会带着跳变的 generation 让渲染层 resync。
        log.warn('cognition change broadcast failed', { collection, error: (error as Error).message });
      }
    }, MERGE_WINDOW_MS));
  }
}

/** 测试辅助：清空计数器与挂起窗口（generation 归零）。 */
export function resetCognitionChangeStateForTests(): void {
  generations.clear();
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  pendingNotices.clear();
}

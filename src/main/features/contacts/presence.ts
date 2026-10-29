/**
 * A2A 在线心跳（D-3/FR-25）。
 *
 * 在线状态由服务端按「最近一次心跳 + 120 秒窗口」判定，客户端只需要定时报到。
 * 没心跳时所有人都显示离线——而 @ 面板里离线的联系人按 PRD 是不可选的（AC-03），
 * 等于「能发但选不了」。所以心跳是发送侧的一部分，不是可选的装饰。
 *
 * 只有配置了 Hub 才有意义；失败静默（在线状态不该影响正常使用）。
 */

import { createLogger } from '../../logger';
import { hubConfigured, hubPresencePing } from './hub-client';

const log = createLogger('a2a-presence');

/** PRD：60 秒一次，服务端按 120 秒窗口判定在线。 */
export const A2A_PRESENCE_INTERVAL_MS = 60_000;

export interface PresenceHeartbeatDeps {
  ping?: (userId: string) => Promise<void>;
  configured?: (userId: string) => boolean;
  intervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

let running = false;
let handle: unknown = null;

/** 发一次心跳；失败不抛（在线状态是尽力而为的展示信息）。 */
export async function pingPresenceOnce(userId: string, deps: PresenceHeartbeatDeps = {}): Promise<boolean> {
  // 心跳是发送侧的一部分：没有当前身份的正常会话就不存在在线概念（T2.2）。
  if (!userId) return false;
  if (!(deps.configured ?? hubConfigured)(userId)) return false;
  try {
    await (deps.ping ?? hubPresencePing)(userId);
    return true;
  } catch (error) {
    log.warn('presence heartbeat failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 启动心跳；重复调用是空操作。返回停止函数。 */
export function startPresenceHeartbeat(userId: string, deps: PresenceHeartbeatDeps = {}): () => void {
  if (running) return stopPresenceHeartbeat;
  if (!userId || !(deps.configured ?? hubConfigured)(userId)) {
    // 没配 Hub 时没有在线概念（本地栈），不挂空计时器。
    return () => {};
  }
  running = true;
  const setI = deps.setIntervalFn ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const timer = setI(() => { void pingPresenceOnce(userId, deps); }, deps.intervalMs ?? A2A_PRESENCE_INTERVAL_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  handle = timer;
  void pingPresenceOnce(userId, deps);
  return stopPresenceHeartbeat;
}

export function stopPresenceHeartbeat(): void {
  if (!running) return;
  running = false;
  if (handle !== null) (clearInterval as unknown as (h: unknown) => void)(handle);
  handle = null;
}

/** 测试用：重置运行标记。 */
export function resetPresenceHeartbeatForTest(): void {
  running = false;
  handle = null;
}

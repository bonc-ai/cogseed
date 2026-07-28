import { buildRunner } from '../../model/core-agent/runner';
import { loadEngine } from './engine-loader';

// 引擎的 LlmResult 结构（进程内引擎导出，本文件只需结构约定）。
export interface LlmResult { text: string; degraded: boolean; }
export type LlmComplete = (prompt: string) => Promise<LlmResult>;

type BuildRunnerFn = typeof buildRunner;

interface BridgeOptions {
  userId: string;
  agentId: string;               // '' = 默认 scope，跟 Orkas 当前 agent 模型
  buildRunnerFn?: BuildRunnerFn; // 测试注入
}

/**
 * 把 core-agent 的 buildRunner 包装成引擎需要的 LlmComplete。
 * - 模型/profile 由 buildRunner 内部解析 → 与 Orkas agent 同步。
 * - 空返回或抛错一律降级为引擎 ruleFallbackComplete，标 degraded:true，绝不外抛。
 * - session kind 固定 evolution-，与 commander/worker 隔离。
 */
export function buildLlmComplete(opts: BridgeOptions): LlmComplete {
  const build = opts.buildRunnerFn ?? buildRunner;
  return async (prompt: string) => {
    try {
      const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const { runner } = await build({ sessionId: `evolution-${tail}`, userId: opts.userId, agentId: opts.agentId });
      const text = await runner.runReflection(prompt);
      if (text && text.trim()) return { text, degraded: false };
    } catch {
      /* fall through to degraded */
    }
    const engine = await loadEngine();
    return engine.ruleFallbackComplete(prompt);
  };
}

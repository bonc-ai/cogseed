import { buildRunner } from '../../model/core-agent/runner';
import { loadEngine } from './engine-loader';
import {
  MANAGEMENT_ONLY_AGENT_ERROR_CODE,
  getAgent,
  isAgentChatDispatchable,
} from '../agents';

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
 * - 空返回或普通模型错误降级为引擎 ruleFallbackComplete，标 degraded:true。
 * - 管理面 Agent 是明确的权限边界，不允许规则引擎绕过并继续 Evolution。
 * - session kind 固定 evolution-，与 commander/worker 隔离。
 */
export function buildLlmComplete(opts: BridgeOptions): LlmComplete {
  const build = opts.buildRunnerFn ?? buildRunner;
  return async (prompt: string) => {
    try {
      if (opts.agentId) {
        const agent = await getAgent(opts.agentId);
        if (agent && !isAgentChatDispatchable(agent)) {
          throw Object.assign(
            new Error('Management-only Agents cannot run Evolution.'),
            { code: MANAGEMENT_ONLY_AGENT_ERROR_CODE },
          );
        }
      }
      const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const { runner } = await build({ sessionId: `evolution-${tail}`, userId: opts.userId, agentId: opts.agentId });
      const text = await runner.runReflection(prompt);
      if (text && text.trim()) return { text, degraded: false };
    } catch (error) {
      if ((error as { code?: string }).code === MANAGEMENT_ONLY_AGENT_ERROR_CODE) throw error;
      /* fall through to degraded */
    }
    const engine = await loadEngine();
    return engine.ruleFallbackComplete(prompt);
  };
}

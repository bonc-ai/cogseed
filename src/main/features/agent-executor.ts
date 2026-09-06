/**
 * AgentExecutor —— group_chat 总线的智能体执行收口层（R2 第一轮）。
 *
 * 设计对齐现成抽象：RuntimeExecutor（cogseed_runtime/runtime-executor.ts，
 * 函数式 (request, opts) => AsyncIterable）与 CogSeedLocalCliExecutionAdapter
 * （cogseed_backend/local-cli-execution-adapter.ts 的 { run(input, opts) }）。
 * 这里选择对象式接口（{ kind, run(turn) }）：kind 让分发点（总线外接分支）
 * 与实现解耦，run 的输入/输出按 bus 外接分支实际传给 runP3394GatewayTurn
 * 的字段现状提取——接口只做收敛层，不改变总线现有行为。
 *
 * 收口分两轮（本轮为第一轮）：
 *  - gateway 路径已收口：总线外接分支经 resolveAgentExecutor 分发执行。
 *  - in_process 内置 LLM 循环仍留在 bus（内置分支与总线状态——流式气泡、
 *    工具桥、coordinator lease——耦合深，硬搬风险大）；本轮先落接口与
 *    直通标记实现，第二轮再把循环体迁入 inProcessExecutor。
 */

import type { Agent } from './agents';
import { isP3394GatewayAgent } from './agents';
import type {
  P3394GatewayTurnInput,
  P3394GatewayTurnResult,
} from './p3394_bridge/p3394-gateway-turn';

/** 执行后端种类：与归一后的 AgentRuntime 二态一一对应。 */
export type AgentExecutorKind = 'in_process' | 'p3394-gateway';

/**
 * 单轮执行输入。第一轮与 P3394GatewayTurnInput 结构一致（gateway 是唯一
 * 真实执行的路径；in_process 循环迁入后再按需分化 Turn 形态）。
 */
export type AgentExecutorTurn = P3394GatewayTurnInput;

/**
 * 单轮执行产出：总线消费面的收敛（text / produced / 错误三元组
 * failureKind·failureCode·infrastructureFailure / aborted / metrics）。
 * `produced` 归一为数组（网关结果中可缺省，总线原以 `|| []` 兜底）。
 */
export interface AgentExecutorOutcome {
  text: string;
  produced: string[];
  error?: string;
  failureKind?: string;
  failureCode?: string;
  infrastructureFailure?: boolean;
  aborted?: boolean;
  metrics?: P3394GatewayTurnResult['metrics'];
}

/** 智能体单轮执行器。总线只依赖此接口，不感知具体执行通道。 */
export interface AgentExecutor {
  kind: AgentExecutorKind;
  run(turn: AgentExecutorTurn): Promise<AgentExecutorOutcome>;
}

/**
 * 外接（P3394 网关）执行器：每轮经桥出站 hub 与受管网关节点协作。
 * 保持总线原有的 dynamic import 形态（惰性加载；vi.mock 按模块路径命中，
 * 静态/动态 import 均可被替换——选 dynamic 与原行为最接近）。
 */
export const gatewayExecutor: AgentExecutor = {
  kind: 'p3394-gateway',
  async run(turn) {
    const { runP3394GatewayTurn } = await import('./p3394_bridge/p3394-gateway-turn');
    const result = await runP3394GatewayTurn(turn);
    return { ...result, produced: result.produced ?? [] };
  },
};

/**
 * 内置（in-process）执行器：第一轮为直通标记实现。内置 LLM 循环仍在
 * group_chat/bus 的内置分支执行，生产路径不会调用本实现；被误用时返回
 * 结构化错误（承载原 G-19 死分支「错误经返回值而非异常」的语义）。
 */
export const inProcessExecutor: AgentExecutor = {
  kind: 'in_process',
  async run() {
    return {
      text: '',
      produced: [],
      error:
        'agent_executor_in_process_unwired: the in-process loop still runs inside group_chat/bus (two-phase consolidation, phase 1)',
      failureKind: 'runtime',
      failureCode: 'agent_executor_in_process_unwired',
      infrastructureFailure: true,
    };
  },
};

/**
 * 按 agent 的归一 runtime kind 分发执行器：外接（p3394-gateway）走网关，
 * 其余（含无 runtime 的默认）走内置。isP3394GatewayAgent 与 deprecated
 * 的 isCliAgent 语义等价（G-19 后外接只有网关一种）。
 */
export function resolveAgentExecutor(
  agent: Pick<Agent, 'runtime'> | null | undefined,
): AgentExecutor {
  return isP3394GatewayAgent(agent) ? gatewayExecutor : inProcessExecutor;
}

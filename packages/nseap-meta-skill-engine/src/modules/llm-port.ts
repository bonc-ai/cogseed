/**
 * LLM 注入端口：引擎不直接依赖任何模型 SDK。
 * PC 侧用 buildRunner 提供真实现；测试注入 mock；缺省走规则降级。
 */
export interface LlmResult {
  text: string;
  degraded: boolean; // true = 规则降级产物，UI 需显式提示
}

export type LlmComplete = (prompt: string) => Promise<LlmResult>;

/** 无 LLM 时的确定性兜底：不凭空生成，回显结构化提示并标记降级。 */
export const ruleFallbackComplete: LlmComplete = async (prompt: string) => {
  const head = prompt.slice(0, 120).replace(/\s+/g, ' ').trim();
  return {
    text: `[规则降级：未接入模型] 基于输入要点的结构化占位结果。输入摘要：${head}`,
    degraded: true,
  };
};

/**
 * Session-import extraction prompts.
 *
 * Candidate fields and classification rules come from the shared Recall
 * contract. Session import adds only its summary envelope and source-specific
 * constraints; the extracted candidates then enter the common candidate store.
 */
import { prompts } from './loader';

/** Map pass: summarise one transcript (or one chunk) and pull candidates. */
export const EXTRACT_SYSTEM_PROMPT = [
  `你是一个会话提炼助手。用户从其他 AI 工具导入了一段历史会话。请将它压缩成“上次进展”简报，并从会话中提取可复用的认知候选。

严格只输出一个 JSON 对象，不要有任何额外文字、解释或 markdown 代码块。顶层结构为：

{
  "summary": "简短说明会话做了什么、达成了什么结论、还有什么遗留问题或下一步，控制在 200 字以内。",
  "candidates": []
}

最多返回 3 条候选；每条都必须基于至少一条用户消息。问候、状态检查、失败的工作不算候选。没有足够持久价值时返回空数组。
本导入路径没有向你提供现有资产清单，因此新候选的 suggestedAction 必须是 create；不要猜测目标资产。
输入消息使用 [m1]、[m2] 等标签；evidence 必须是这些消息标签组成的数组，例如 ["m1"]。输出语言跟随会话本身的语言。`,
  prompts.load('recall_candidate_contract'),
].join('\n\n');

/** Reduce pass: merge partial summaries and dedupe candidates. */
export const REDUCE_SYSTEM_PROMPT = [
  `你在合并同一段长会话分段提炼后的多个简报。请整合成一份连贯的最终简报，并去重认知候选。

严格只输出一个 JSON 对象，顶层含 summary 与 candidates。候选字段遵循下方共享契约。
合并语义重复的候选，保留信息最全的一条；保留输入中的 evidence 消息标签，不新增证据或内容；输出语言跟随输入。`,
  prompts.load('recall_candidate_contract'),
].join('\n\n');

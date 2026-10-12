/**
 * 入池正文闸门（2026-09-29 子安拍板「彻底根治」可复用内容冗长）。
 *
 * 根因：抽取契约（prompts/recall_candidate_contract.md 的 120/200 字、去
 * 路径、去会话残留条款）只约束模型自觉，生成端没有执行层——超长、带
 * 会话号、带本机路径的正文原样进池，唯一兜底是事后治理轮与人工手改。
 *
 * 本闸在 saveRecallCandidate 锁外预处置：机器生成的候选正文命中
 * recallStatementIssues（too_long / session_debris / local_path）时，先过
 * suggestAbilityAssetStatement 改写再入池——候选正文是模型刚从对话抽出的
 * 机器产物、且尚未经用户确认，此时改写不是篡改知识；改写器自带 3 轮重试
 * 与双重把关（复检同一份 policy + 长度不增长），铁律「知识点一条不丢，
 * 只删怎么来的」。
 *
 * 谁不被改写：
 *  - origin='manual'（用户「记一条」亲写）与显式声明 rawStatement 的忠实
 *    搬运线（对话中当场记 / 旧记忆迁移 / 旧本体导入）：文本是用户口述或
 *    历史原文，机器改写=篡改；确认页警示与治理轮仍可兜底。
 *  - 改写失败（模型未配置 / 鉴权过期 / 重试耗尽）：原文入池——对话是一次
 *    性的，宁可有警示的原文等人确认，不丢知识；失败只 warn 不阻断。
 *
 * 为什么收口在 saveRecallCandidate 而不是各生成线：全部入池线（会话整理、
 * KSTAR 复盘、teaching 回流、会议结论、会话导入）与未来新增线都过这一
 * 个口，一处治理代代收齐；幂等无虞——改写器输出必过同一份 policy 复检，
 * 已合规正文零 LLM 成本直通。
 */
import { createLogger } from '../../logger';
import { recallStatementIssues } from './statement-policy';
import { suggestAbilityAssetStatement } from './asset-statement-rewrite';
import type { AbilityAssetType } from './candidate-service';

const log = createLogger('recall.candidate-statement-gate');

/** 预处置候选正文：不合规的机器生成正文先改写，豁免线与失败降级原文。 */
export async function gateCandidateStatement(
  userId: string,
  input: { judgment: string; suggestedType: AbilityAssetType; skip?: boolean },
): Promise<string> {
  const original = String(input.judgment || '');
  if (input.skip) return original;
  const text = original.trim();
  if (!text) return original;
  const issues = recallStatementIssues({ statement: text, type: input.suggestedType });
  if (!issues.length) return original;
  try {
    const rewritten = await suggestAbilityAssetStatement(userId, {
      statement: text,
      type: input.suggestedType,
    });
    return rewritten.statement;
  } catch (error) {
    log.warn('candidate statement gate fallback to original', {
      issues,
      error: error instanceof Error ? error.message : String(error),
    });
    return original;
  }
}

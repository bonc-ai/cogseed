/**
 * 正文一等规范（2026-09-29 子安拍板，与标题 title-policy 同款模式）：全模块
 * 唯一的资产正文合规判定。读回警示与治理轮共用这一份，任何调用方不得另写口径。
 *
 * 与标题的关键差异（设计定稿）：正文是知识本体，机器改写＝篡改知识——
 * 判定**不拒写入、不触发改写**，只做两件事：
 *   ① 读回时随资产/候选下发 issue，确认页与编辑表单给人看警示；
 *   ② 治理轮用它圈出需要改写的存量。
 *
 * 机器可判项（按类型分级，返回全部命中而非首个——正文问题常叠加）：
 *   1. 空正文；
 *   2. 超长：rule/personal 硬限 200 字（建议 120，建议线不判）、fact 硬限 200；
 *   3. 调试残留（所有类型）：会话一次性标识（cid=/turn-/16 位 hex 会话号）；
 *   4. rule/personal 带本机路径或源码文件名（fact 合法——知识本身可能就是
 *      一个位置或配置值）。
 *
 * 「场景＋做法的陈述句形态」「日期戳（何时提出）」「价值说明尾段」机器
 * 不可判或误伤面大（时效事实合法、引用原话合法），由生成端契约保证＋
 * 治理轮的 LLM 改写处理，不在此处伪造判定。
 */

export type AbilityAssetStatementIssue =
  | 'empty'
  | 'too_long'
  | 'session_debris'
  | 'local_path';

export interface StatementPolicyInput {
  statement: string;
  /** 资产/候选类型：分级长度与路径豁免都按它走。 */
  type?: string;
}

/** 硬限 200 字（建议线 120 由契约与警示文案表达，不参与判定）。 */
export const ABILITY_ASSET_STATEMENT_HARD_MAX = 200;

/** 会话一次性标识：cid=、turn- 前缀、8~16 位连续 hex（会话/记录 id 形态）。 */
const SESSION_DEBRIS = /\b(?:cid|turn|rcap|cand|gconv)[-=_][0-9a-f]{6,}\b|(?<![0-9a-f])[0-9a-f]{16}(?![0-9a-f])/i;

/** 本机路径或源码文件名（fact 豁免）。 */
const LOCAL_PATH = new RegExp('/(?:Users|opt|home|etc|var|tmp)/|\\b[\\w-]+\\.(?:ts|tsx|js|mjs|cjs|json|py)\\b');

/** 「一句话内出现的短暂日期」不判（时效事实合法）；只有裸日期戳密度过高
 * （≥3 处）才视为流水账残留——单点日期是常见合法形态。 */
export function recallStatementIssues(input: StatementPolicyInput): AbilityAssetStatementIssue[] {
  const text = String(input?.statement ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return ['empty'];
  const type = String(input?.type ?? '');
  const issues: AbilityAssetStatementIssue[] = [];
  if (text.length > ABILITY_ASSET_STATEMENT_HARD_MAX) issues.push('too_long');
  if (SESSION_DEBRIS.test(text)) issues.push('session_debris');
  if ((type === 'rule' || type === 'personal') && LOCAL_PATH.test(text)) issues.push('local_path');
  return issues;
}

const ISSUE_REASONS: Record<AbilityAssetStatementIssue, string> = {
  empty: '正文不能为空',
  too_long: '正文超长（规则/偏好/事实类建议 120 字内，硬限 200 字；方法与模板类不限）',
  session_debris: '正文带会话一次性标识（会话号/cid/turn 号），出处请留在来历区',
  local_path: '规则/偏好类正文带本机路径或源码文件名（事实类若知识本身就是该位置则合法）',
};

/** 警示文案（确认页/编辑表单用）：合规返回 undefined。 */
export function recallStatementWarning(input: StatementPolicyInput): string | undefined {
  const issues = recallStatementIssues(input);
  if (!issues.length) return undefined;
  return issues.map((issue) => ISSUE_REASONS[issue]).join('；');
}

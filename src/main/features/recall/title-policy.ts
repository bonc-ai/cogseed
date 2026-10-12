/**
 * 标题一等化（设计《认知资产-四病整改设计-20260928》3.1）：全模块唯一的
 * 资产标题合规判定。验收脚本与写入闸门共用这一份，任何调用方不得另写口径。
 *
 * 机器可判四项（按此顺序判定，返回首个命中）：
 *   1. 非空；
 *   2. 中文 ≤16 字、其他语言 ≤60 字符（含任一汉字即按中文口径）；
 *   3. 不与正文开头重复（与 statement 公共前缀 ≥1 字即不合规）；
 *   4. 不以标点结尾。
 *
 * 「名词性短语、独立可读」机器不可判，由生成端提示词保证＋人工抽样核验
 * （设计 3.1），不在此处伪造判定。历史版本快照里冻结的不合规标题物理不动
 * （版本流只追加）；在用版的合规由回滚/选版闸门保证（设计 3.2 拍板项 #2）。
 */

export type AbilityAssetTitleIssue =
  | 'empty'
  | 'too_long'
  | 'prefix_overlap'
  | 'punctuation_suffix';

/** 含任一汉字即按中文口径计长（与 candidate-service 的 fallbackCandidateTitle
 *  同款判据，避免两处长短口径分叉）。 */
const HAN_SCRIPT = /\p{Script=Han}/u;

export const ABILITY_ASSET_TITLE_MAX_HAN = 16;
export const ABILITY_ASSET_TITLE_MAX_OTHER = 60;

/** 结尾句读：中英文常用收尾标点，含截断省略号「…」（makeDisplayTitle 截断
 *  特征）与成对符号的收边（）”』》等）。 */
const TRAILING_PUNCTUATION
  = /[.,;:!?…、。，；：！？…”'’"》〉」』）)】］\]]$/;

/** 与写入口 bounded 同款归一（折叠空白 + trim）：判定按落盘形态算，
 *  「两端带空格的超长标题」不能因为空白被折叠前后的口径差而漏判。 */
function normalizeForPolicy(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 标题长度上限：含汉字按 16 字，否则按 60 字符。 */
export function abilityAssetTitleLimit(title: string): number {
  return HAN_SCRIPT.test(String(title || ''))
    ? ABILITY_ASSET_TITLE_MAX_HAN
    : ABILITY_ASSET_TITLE_MAX_OTHER;
}

/**
 * 判定标题是否合规：合规返回 undefined，不合规返回首个命中的问题码。
 *
 * `statement` 是标题将来与之共存的正文（写入闸门传写入后的最终正文）。
 * 正文为空/缺失时不判「与正文开头重复」——没有正文就没有可重复的开头。
 */
export function recallTitleIssue(title: string, statement?: string): AbilityAssetTitleIssue | undefined {
  const normalized = normalizeForPolicy(title);
  if (!normalized) return 'empty';
  if (normalized.length > abilityAssetTitleLimit(normalized)) return 'too_long';
  const body = normalizeForPolicy(String(statement ?? ''));
  if (body && normalized[0] === body[0]) return 'prefix_overlap';
  if (TRAILING_PUNCTUATION.test(normalized)) return 'punctuation_suffix';
  return undefined;
}

const ISSUE_REASONS: Record<AbilityAssetTitleIssue, string> = {
  empty: '标题不能为空',
  too_long: '标题超长（含汉字时不超过 16 字，其他语言不超过 60 字符）',
  prefix_overlap: '标题不能与正文开头重复',
  punctuation_suffix: '标题不能以标点结尾',
};

/**
 * 收口闸门用：不合规即抛可读错误。消息以 `invalid ability asset title` 开头，
 * `classifyAbilityAssetWriteFailure` 据此把失败归因为 schema。
 */
export function assertCompliantAbilityAssetTitle(title: string, statement?: string): void {
  const issue = recallTitleIssue(title, statement);
  if (issue) throw new Error(`invalid ability asset title: ${ISSUE_REASONS[issue]}`);
}

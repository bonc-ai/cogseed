/** 认知内容的敏感分级与 L3 准入闸。
 *
 *  分级取自产品规范 16.1：
 *
 *  | 等级 | 定义 | 默认行为 |
 *  |---|---|---|
 *  | L0 | 公开或低风险 | 可在授权 Workspace 中处理 |
 *  | L1 | 一般个人偏好、角色、工作方式 | 本地优先；跨设备需登录和加密 |
 *  | L2 | 客户资料、第三方个人信息、内部业务细节 | 最小化、单独确认、限制外发 |
 *  | L3 | 密钥、口令、未脱敏凭证、Policy 禁止内容 | **不形成候选、不进入 Memory/资产** |
 *
 *  这里只实现 L3 —— 因为只有它是硬约束。L0/L1/L2 的区分需要用户与企业 Policy
 *  参与，不能靠正则猜；猜错把 L2 判成 L0 会造成静默的越权外发，比不判更糟。
 *  所以本模块的返回值只有「是不是 L3」，不假装能自动分出其余三级。
 *
 *  **为什么闸门必须在沉淀入口，而不是只在输出侧脱敏。**
 *  仓库里已有 `log-sanitize` 与回执的脱敏正则，但那些是「东西已经存下来了，
 *  往外发的时候擦掉」。认知资产不一样：它会被冻进能力包、注入 Agent 提示、
 *  写进回执、跨会话复用。一条凭证一旦成为资产，后面每一环都在忠实地搬运它。
 *  所以要在「形成候选」这一步就拦住，让它根本不进入这条链路。
 *
 *  **判定偏严不偏宽。** 误判一条普通判断为 L3，用户损失是这条没沉淀下来，
 *  重说一次即可；漏判一条真凭证，损失是它被永久固化并反复注入。两者不对称，
 *  所以宁可拦错。
 */

import { SENSITIVE_FIELD_PATTERN } from './log-sanitize';

export type SensitivityLevel = 'L3' | 'unclassified';

export interface SensitivityVerdict {
  level: SensitivityLevel;
  /** 命中的规则名，用于向用户解释为什么没有沉淀。不含命中的原文。 */
  reason?: string;
}

/** `key: "value"` / `key = value` / `{"key": "value"}` 形态的凭证赋值。
 *  只认「字段名 + 分隔符 + 非空值」，单独出现 password 这个词不算——
 *  「密码字段在日志里必须脱敏」是条正当judgment，不该被拦。
 *
 *  字段名后允许一个闭合引号：JSON 里是 `"password":`，字段名与冒号之间隔着引号，
 *  漏掉这一项就能用 JSON 形态整个绕过闸门。 */
const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  `\\b${SENSITIVE_FIELD_PATTERN}\\b["']?\\s*[:=]\\s*["']?[^\\s"',;]+`,
  'i',
);

/** PEM 块：私钥、证书。整块结构特征明显，误判风险低。 */
const PEM_BLOCK_RE = /-----BEGIN[A-Z ]*(PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|CERTIFICATE)-----/i;

/** 常见云厂商与平台的凭证前缀。这些前缀本身就是凭证标识，出现即高危。 */
const KNOWN_TOKEN_PREFIX_RE = new RegExp([
  'AKIA[0-9A-Z]{12,}',            // AWS access key id
  'ASIA[0-9A-Z]{12,}',            // AWS 临时凭证
  'AKID[0-9A-Za-z]{12,}',         // 腾讯云
  'LTAI[0-9A-Za-z]{12,}',         // 阿里云
  'gh[pousr]_[0-9A-Za-z]{16,}',   // GitHub
  'xox[baprs]-[0-9A-Za-z-]{10,}', // Slack
  'sk-[0-9A-Za-z]{20,}',          // 通用 secret key 形态
  'AIza[0-9A-Za-z_-]{20,}',       // Google API key
].join('|'));

/** `Authorization: Bearer <token>` 形态。 */
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i;

/** 连接串里内嵌的口令：`scheme://user:pass@host`。 */
const URL_CREDENTIAL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i;

const L3_RULES: Array<{ re: RegExp; reason: string }> = [
  { re: PEM_BLOCK_RE, reason: 'private_key_block' },
  { re: KNOWN_TOKEN_PREFIX_RE, reason: 'known_credential_prefix' },
  { re: URL_CREDENTIAL_RE, reason: 'credential_in_url' },
  { re: BEARER_RE, reason: 'bearer_token' },
  { re: CREDENTIAL_ASSIGNMENT_RE, reason: 'credential_assignment' },
];

/** 判定一段文本是否触及 L3。命中即返回，不继续找——原因给一个就够解释了。 */
export function classifyCognitionSensitivity(text: unknown): SensitivityVerdict {
  if (typeof text !== 'string' || !text.trim()) return { level: 'unclassified' };
  for (const rule of L3_RULES) {
    // 正则都不带 /g，无 lastIndex 残留问题。
    if (rule.re.test(text)) return { level: 'L3', reason: rule.reason };
  }
  return { level: 'unclassified' };
}

/** 多段文本一起判：任一段命中即整体 L3。候选的 judgment/summary 等要一起过闸，
 *  否则把凭证写在 summary 里就能绕过去。 */
export function classifyCognitionSensitivityOfParts(parts: unknown[]): SensitivityVerdict {
  for (const part of parts) {
    const verdict = classifyCognitionSensitivity(part);
    if (verdict.level === 'L3') return verdict;
  }
  return { level: 'unclassified' };
}

/** 沉淀入口用的断言。L3 直接抛错——规范 16.1 要求「不形成候选」，
 *  静默丢弃则违反「无需更新也要透明」，所以给出可展示的原因。 */
export function assertNotForbiddenToPersist(parts: unknown[]): void {
  const verdict = classifyCognitionSensitivityOfParts(parts);
  if (verdict.level === 'L3') {
    throw new Error(`cognition is forbidden to persist: ${verdict.reason}`);
  }
}

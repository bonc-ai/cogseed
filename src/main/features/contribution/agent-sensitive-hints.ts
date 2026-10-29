/**
 * 提交预览页的"可能包含本机信息"提示 —— 只提示，不改一个字。
 *
 * 产品与 Hub 的口径（2026-10-13，Hub spec US3 场景 3a）：Agent 的创作正文里如果有本机路径或疑似凭据，
 * 客户端在预览页**高亮提示**这些位置，用户确认后按用户确认的内容提交；**不得**未经确认自动替换或删除正文。
 * 字段级的本机信息（连接器、模型偏好等）另有剥离，见 `agent-package-rules.toDistributableAgent`。
 *
 * ## 刻意写得很小
 * 评审会结论是"只拦最明显的，不穷举，不做成长期维护的规则库"。所以这里只认两类、每类几条，宁可漏报也不
 * 误报一堆让人学会忽略；它不是安全扫描（那是 `admission` 的事），命中也**不阻断**，只要求用户看一眼并确认。
 * 要加规则前先想想这条边界。
 *
 * 命中的摘录里，疑似凭据的值会被遮住（只留前几位），这些摘录只在本机预览里显示，不上传，但仍不该把整串
 * 凭据再打印出来（截图、录屏、日志）。
 *
 * 叶模块：纯函数，不读盘；调用方传入文件内容。
 */

export type SensitiveHintKind = 'local_path' | 'credential_like';

export interface SensitiveHint {
  kind: SensitiveHintKind;
  /** 包内相对路径，正斜杠。 */
  file: string;
  /** 1 起算的行号。 */
  line: number;
  /** 命中片段；疑似凭据的值已遮挡。 */
  excerpt: string;
}

interface Rule {
  kind: SensitiveHintKind;
  re: RegExp;
  /** 把命中片段整理成可展示的摘录（遮挡凭据的值）。 */
  show: (match: string) => string;
}

const asIs = (m: string): string => m;
/** 保留前 4 位，其余遮住；太短的整个遮住。 */
const mask = (value: string): string => (value.length <= 8 ? '****' : `${value.slice(0, 4)}…****`);

const RULES: readonly Rule[] = [
  // 本机路径：系统里最典型的用户目录。相对路径、`~/`、普通的 `/usr/bin` 不算——它们不带用户名。
  { kind: 'local_path', re: /\/Users\/[^\s/"'`<>|:*?]+(?:\/[^\s"'`<>|:*?]*)?/g, show: asIs },
  { kind: 'local_path', re: /\/home\/[^\s/"'`<>|:*?]+(?:\/[^\s"'`<>|:*?]*)?/g, show: asIs },
  { kind: 'local_path', re: /\b[A-Za-z]:\\Users\\[^\s\\"'`<>|:*?]+(?:\\[^\s"'`<>|:*?]*)?/g, show: asIs },
  // 疑似凭据：几种格式极其固定的令牌，加"名字像密钥、值像随机串"的赋值。
  { kind: 'credential_like', re: /\bsk-[A-Za-z0-9_-]{16,}/g, show: mask },
  { kind: 'credential_like', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, show: mask },
  { kind: 'credential_like', re: /\bAKIA[0-9A-Z]{16}\b/g, show: mask },
  { kind: 'credential_like', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, show: (m) => `Bearer ${mask(m.replace(/^Bearer\s+/, ''))}` },
  {
    kind: 'credential_like',
    re: /\b(?:api[_-]?key|secret|token|passwd|password|access[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}/gi,
    show: (m) => m.replace(/([:=]\s*["']?)([A-Za-z0-9_\-./+=]{8,})$/, (_all, head: string, value: string) => `${head}${mask(value)}`),
  },
];

/** 单个文件最多报多少条，整体最多多少条：避免一个被塞满的文件把预览页淹没。 */
export const MAX_HINTS_PER_FILE = 10;
export const MAX_HINTS_TOTAL = 50;

/** 扫一个文本文件的内容。同一行同一类只报一次。 */
export function scanTextForHints(file: string, content: string): SensitiveHint[] {
  const out: SensitiveHint[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < MAX_HINTS_PER_FILE; i += 1) {
    const seenKinds = new Set<SensitiveHintKind>();
    for (const rule of RULES) {
      if (seenKinds.has(rule.kind)) continue;
      rule.re.lastIndex = 0;
      const m = rule.re.exec(lines[i]);
      if (!m) continue;
      seenKinds.add(rule.kind);
      out.push({ kind: rule.kind, file, line: i + 1, excerpt: rule.show(m[0]) });
      if (out.length >= MAX_HINTS_PER_FILE) break;
    }
  }
  return out;
}

/** 判断是不是二进制：含 NUL 字节。二进制不扫。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/** 扫一批文件。`read` 返回文件字节；读不到的文件跳过，不让提示功能挡住贡献。 */
export function scanFilesForHints(
  files: ReadonlyArray<{ path: string; size: number }>,
  read: (relPath: string) => Uint8Array | null,
  opts: { maxFileBytes?: number } = {},
): SensitiveHint[] {
  const maxBytes = opts.maxFileBytes ?? 256 * 1024;
  const out: SensitiveHint[] = [];
  for (const f of files) {
    if (out.length >= MAX_HINTS_TOTAL) break;
    if (f.size > maxBytes) continue;
    let bytes: Uint8Array | null = null;
    try { bytes = read(f.path); } catch { bytes = null; }
    if (!bytes || looksBinary(bytes)) continue;
    for (const hint of scanTextForHints(f.path, Buffer.from(bytes).toString('utf8'))) {
      if (out.length >= MAX_HINTS_TOTAL) break;
      out.push(hint);
    }
  }
  return out;
}

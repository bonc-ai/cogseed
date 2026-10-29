/**
 * Agent 包规则 —— 贡献 Agent 时 `agent.json` 与包布局的**纯判定**（叶模块：无 IO、无 Electron、
 * 不 import 其他 feature），供提交前本机检查、请求体组装和联调脚本直接调用。
 *
 * 规则来源：`specs/008-hub-agent-distribution/contracts/agent-package.schema.json`（v1.1 草案）
 * 与 `agent-api-proposal.md` v3。枚举与该 schema 保持一致，`agent-package-rules.test.ts` 会读 schema
 * 逐项比对，防止两边漂移。仓库没有 `ajv` 运行时依赖，所以这里用已有的 `zod` 手写等价校验。
 *
 * `skill_list` 里 `builtin:<name>`（客户端内置能力，产品 2026-10-13 决定做）：名字在 `agent_builtin_capabilities`
 * 的开放清单内才通过，清单外的拒绝（与 Hub 对清单外引用的口径一致）。
 */
import { z } from 'zod';

import { isKnownBuiltinRef, parseBuiltinRef } from '../agent_builtin_capabilities';

// ── 枚举（与 agent-package.schema.json 对齐；crown 不可分发，已排除）─────────────

export const AGENT_CATEGORIES = ['education', 'ecommerce', 'rnd', 'creation', 'data', 'office', 'general'] as const;

export const AGENT_ICONS = [
  'sparkle', 'rocket', 'brain', 'bulb', 'bot', 'atom', 'compass', 'search', 'flame', 'film', 'star', 'bolt',
  'target', 'music', 'code', 'palette', 'document', 'spreadsheet', 'presentation', 'image', 'chart',
  'graduation-cap', 'book-open', 'calculator', 'users', 'megaphone', 'shopping-bag', 'archive', 'activity',
  'git-pull-request', 'briefcase', 'clipboard', 'cogseed', 'pen', 'doc', 'book', 'flag', 'globe', 'shield',
  'scale', 'wrench', 'compare',
] as const;

export const AGENT_COLORS = [
  'gold', 'coral', 'mint', 'lavender', 'peach', 'sky', 'sunshine', 'rose', 'sage', 'periwinkle', 'butter',
  'blush', 'cyan', 'violet', 'lime', 'salmon', 'emerald',
] as const;

export const AGENT_INPUT_TYPES = [
  'text', 'textarea', 'select', 'multiselect', 'number', 'boolean', 'file', 'directory',
] as const;

export const AGENT_OUTPUT_FORMATS = ['auto', 'text', 'dashboard', 'artifact'] as const;

/** 12 位小写十六进制 = Hub 内容 ID。 */
const HUB_ID_RE = /^[a-f0-9]{12}$/;
/** 随包私有 Skill 的名字形式：不得恰为 12 位十六进制（与 Hub ID 互斥）。 */
const BUNDLED_NAME_RE = /^(?![a-f0-9]{12}$)[\p{L}][\p{L}\p{N}_-]*$/u;
const BUILTIN_PREFIX = 'builtin:';
const INPUT_ID_RE = /^[a-z_][a-z0-9_]{0,31}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── 名称规则（客户端字符集为准；宽度算法与 Hub nameRules.ts 同款区间）──────────────

/** 名称显示宽度上限，宽/全角字符计 2。 */
export const MAX_NAME_DISPLAY_WIDTH = 60;

/** 保留名，去空白、转小写后比较（与 `agents.ts` 的 RESERVED_AGENT_NAMES 同集合）。 */
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set([
  '指挥官', '总指挥', 'コマンダー', '司令官', 'commander', 'cogseed',
]);

const NAME_CHARSET_RE = /^[A-Za-z0-9_一-鿿-]+$/;

const isWideCodePoint = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f)
  || (cp >= 0x2e80 && cp <= 0x303e)
  || (cp >= 0x3041 && cp <= 0x33ff)
  || (cp >= 0x3400 && cp <= 0x4dbf)
  || (cp >= 0x4e00 && cp <= 0x9fff)
  || (cp >= 0xa000 && cp <= 0xa4cf)
  || (cp >= 0xac00 && cp <= 0xd7a3)
  || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xfe30 && cp <= 0xfe6f)
  || (cp >= 0xff00 && cp <= 0xff60)
  || (cp >= 0xffe0 && cp <= 0xffe6)
  || (cp >= 0x20000 && cp <= 0x3fffd);

/** 显示宽度：宽/全角计 2，其余计 1，按码点遍历。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

export type NameRule = 'name.required' | 'name.charset' | 'name.reserved' | 'name.width';

/** 判定顺序固定：required → charset → reserved → width（与共用测试向量一致）。 */
export function checkAgentName(name: unknown): NameRule | null {
  if (typeof name !== 'string' || name.trim() === '') return 'name.required';
  if (!NAME_CHARSET_RE.test(name)) return 'name.charset';
  if (RESERVED_AGENT_NAMES.has(name.replace(/\s+/g, '').toLowerCase())) return 'name.reserved';
  if (displayWidth(name) > MAX_NAME_DISPLAY_WIDTH) return 'name.width';
  return null;
}

// ── skill_list 分类 ───────────────────────────────────────────────────────────

/**
 * `hub`：Hub 已发布 Skill（需从 Hub 取）；`bundled`：随 Agent 提交的私有 Skill；
 * `builtin`：客户端内置能力（本期不支持）；`invalid`：形态不合法。
 */
export type SkillRefKind = 'hub' | 'bundled' | 'builtin' | 'invalid';

export function classifySkillRef(ref: string): SkillRefKind {
  if (HUB_ID_RE.test(ref)) return 'hub';
  if (ref.startsWith(BUILTIN_PREFIX)) return 'builtin';
  if (BUNDLED_NAME_RE.test(ref)) return 'bundled';
  return 'invalid';
}

// ── agent.json 校验 ───────────────────────────────────────────────────────────

export interface AgentPackageIssue {
  /** 域内码，对应 `server_check.blocking[].code`。 */
  code: 'AGENT_SCHEMA_INVALID' | 'SKILL_REF_NOT_FOUND' | 'PRIVATE_SKILL_INVALID';
  /** 形如 `agent.field.unexpected`、`name.charset`、`skill_ref.format`。 */
  rule: string;
  path: string;
  message: string;
}

const inputOption = z.object({ value: z.string().min(1), label: z.string().optional() }).strict();
const stringOrNumberOrBoolOrList = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const agentInput = z.object({
  id: z.string().regex(INPUT_ID_RE),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(AGENT_INPUT_TYPES),
  required: z.boolean().optional(),
  default: stringOrNumberOrBoolOrList,
  default_by_ui_language: z.object({
    zh: z.string().optional(), en: z.string().optional(), ja: z.string().optional(), pt: z.string().optional(),
  }).strict().optional(),
  options: z.array(inputOption).min(1).optional(),
  placeholder: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  multiple: z.boolean().optional(),
  accept: z.string().optional(),
}).strict().superRefine((v, ctx) => {
  const bad = (message: string, path: string[] = ['default']): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };
  if ((v.type === 'select' || v.type === 'multiselect') && !v.options) bad('select/multiselect requires options', ['options']);
  if (v.type === 'number' && typeof v.default !== 'number') bad('number input default must be a number');
  if (v.type === 'boolean' && typeof v.default !== 'boolean') bad('boolean input default must be a boolean');
  if (['text', 'textarea', 'select', 'directory'].includes(v.type) && typeof v.default !== 'string') bad('default must be a string');
  if (v.type === 'multiselect' && !Array.isArray(v.default)) bad('multiselect default must be a string list');
});

const agentJsonSchema = z.object({
  agent_id: z.string().regex(AGENT_ID_RE).optional(),
  name: z.string(),
  description_zh: z.string().max(800).optional(),
  description_en: z.string().max(800).optional(),
  workflow: z.string().min(1),
  icon: z.enum(AGENT_ICONS).optional(),
  color: z.enum(AGENT_COLORS).optional(),
  category: z.enum(AGENT_CATEGORIES),
  skill_list: z.array(z.string()).optional(),
  inputs: z.array(agentInput).optional(),
  interactive: z.boolean().optional(),
  knowhow: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  output_format: z.enum(AGENT_OUTPUT_FORMATS).optional(),
  runtime: z.object({ kind: z.literal('in_process') }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.description_zh === undefined && v.description_en === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'description_zh or description_en is required', path: ['description_zh'] });
  }
});

export type DistributableAgentJson = z.infer<typeof agentJsonSchema>;

const joinPath = (p: ReadonlyArray<string | number>): string => p.map(String).join('.');

function ruleForZodIssue(issue: z.ZodIssue, path: string): string {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) return 'agent.field.unexpected';
  if (path === 'name') return 'name.required';
  return 'agent.field.invalid';
}

export type ValidateAgentJsonResult =
  | { ok: true; agent: DistributableAgentJson }
  | { ok: false; issues: AgentPackageIssue[] };

/**
 * 校验提交用的 `agent.json`。多余字段**拒绝而非忽略**（与 C-02 的 UNEXPECTED_FIELD 口径一致）。
 *
 * `skill_list` 的每一项按 {@link classifySkillRef} 判定；`builtin:` 开头的条目本期不支持，
 * 形态不合法的条目被拒；重复条目被拒。名称另按 {@link checkAgentName} 判定。
 */
export function validateAgentJson(raw: unknown): ValidateAgentJsonResult {
  const issues: AgentPackageIssue[] = [];
  const parsed = agentJsonSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = joinPath(issue.path);
      if (issue.code === z.ZodIssueCode.unrecognized_keys) {
        for (const key of issue.keys) {
          issues.push({
            code: 'AGENT_SCHEMA_INVALID',
            rule: 'agent.field.unexpected',
            path: path ? `${path}.${key}` : key,
            message: `unexpected field: ${key}`,
          });
        }
        continue;
      }
      issues.push({
        code: 'AGENT_SCHEMA_INVALID',
        rule: ruleForZodIssue(issue, path),
        path,
        message: issue.message,
      });
    }
  }

  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : null;
  const nameRule = obj ? checkAgentName(obj.name) : 'name.required';
  if (nameRule && !issues.some((i) => i.path === 'name')) {
    issues.push({ code: 'AGENT_SCHEMA_INVALID', rule: nameRule, path: 'name', message: nameRule });
  } else if (nameRule) {
    // zod 已因类型/缺失报过 name，用更具体的规则名覆盖
    const existing = issues.find((i) => i.path === 'name');
    if (existing) existing.rule = nameRule;
  }

  const list = obj && Array.isArray(obj.skill_list) ? obj.skill_list : [];
  const seen = new Set<string>();
  list.forEach((ref, i) => {
    const path = `skill_list.${i}`;
    if (typeof ref !== 'string') return; // zod 已报
    if (seen.has(ref)) {
      issues.push({ code: 'AGENT_SCHEMA_INVALID', rule: 'skill_ref.duplicate', path, message: `duplicate skill ref: ${ref}` });
    }
    seen.add(ref);
    const kind = classifySkillRef(ref);
    if (kind === 'builtin') {
      if (parseBuiltinRef(ref) === null) {
        issues.push({ code: 'AGENT_SCHEMA_INVALID', rule: 'skill_ref.format', path, message: `invalid builtin ref: ${ref}` });
      } else if (!isKnownBuiltinRef(ref)) {
        issues.push({ code: 'AGENT_SCHEMA_INVALID', rule: 'skill_ref.builtin_unknown', path, message: `not an open built-in capability: ${ref}` });
      }
    } else if (kind === 'invalid') {
      issues.push({ code: 'AGENT_SCHEMA_INVALID', rule: 'skill_ref.format', path, message: `invalid skill ref: ${ref}` });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, agent: parsed.data as DistributableAgentJson };
}

/** 把 `skill_list` 拆成 Hub 依赖、随包私有 Skill 与客户端内置能力（调用前应已通过 {@link validateAgentJson}）。 */
export function splitSkillRefs(skillList: readonly string[] | undefined): { hub: string[]; bundled: string[]; builtin: string[] } {
  const hub: string[] = [];
  const bundled: string[] = [];
  const builtin: string[] = [];
  for (const ref of skillList ?? []) {
    const kind = classifySkillRef(ref);
    if (kind === 'hub') hub.push(ref);
    else if (kind === 'bundled') bundled.push(ref);
    else if (kind === 'builtin') builtin.push(ref);
  }
  return { hub, bundled, builtin };
}

// ── 本机处理（剥离）──────────────────────────────────────────────────────────

/** 生命周期字段：由 Hub 在发布时写入包内 `_meta.json`，作者原文不带。 */
const LIFECYCLE_FIELDS = ['version', 'created_at', 'updated_at'] as const;
/** 本机/用户相关：与用户的连接器实例、模型偏好有关，不分发。 */
const LOCAL_FIELDS = ['enabled_connectors', 'default_model', 'default_thinking', 'create_uid'] as const;
/** 运行时派生与安装态：不属于作者定义。 */
const DERIVED_FIELDS = [
  'enabled', 'source', 'marketplace_published_at', 'marketplace_updated_at', 'default_install',
  'is_open_source', 'status', 'seed_source', 'runtime_stats', 'profile', '_v',
] as const;
/**
 * 可选文本字段：值为空串时等同于"没写"。Hub 对"出现了但为空串"直接拒绝（`agent.description.empty`、
 * `agent.icon.invalid` 等），而本机创建的 Agent 常常把英文描述落成空串，所以提交前移除。
 */
const OPTIONAL_TEXT_FIELDS = ['description_zh', 'description_en', 'icon', 'color', 'output_format'] as const;
/** 宿主专有：只有内置宿主 Agent 才有，出现即不可贡献。 */
const HOST_ONLY_FIELDS = ['management_surface', 'reimbursement_entry_role', 'interaction_mode'] as const;

export type HandledKind = 'lifecycle' | 'local_pref' | 'derived' | 'empty';

/** 本机处理项：只给本机预览看，**不上传**，Hub 不需要知道处理了什么。 */
export interface HandledItem {
  kind: HandledKind;
  field: string;
}

/** 一旦出现就不得贡献的原因。 */
export interface AgentBlocker {
  rule: 'agent.host_only' | 'agent.runtime_not_distributable' | 'agent.icon_not_distributable';
  field: string;
  message: string;
}

export interface DistributableAgent {
  /** 剥离后的作者原文（仍需 {@link validateAgentJson}）。 */
  agent: Record<string, unknown>;
  handled: HandledItem[];
  blockers: AgentBlocker[];
}

/**
 * 从本机 `agent.json` 得到可提交的作者原文。**不修改入参**。
 *
 * 剥离：生命周期、本机偏好、运行时派生字段。阻断：宿主专有字段、非 `in_process` 的运行时
 * （外接 CLI Agent 依赖本机环境）、`crown` 图标（指挥官专用）。未知字段**不静默丢弃**，留给
 * {@link validateAgentJson} 以 `agent.field.unexpected` 拒绝，让作者看到而不是被悄悄改写。
 */
export function toDistributableAgent(raw: Record<string, unknown>): DistributableAgent {
  const agent: Record<string, unknown> = { ...raw };
  const handled: HandledItem[] = [];
  const blockers: AgentBlocker[] = [];

  const strip = (fields: readonly string[], kind: HandledKind): void => {
    for (const field of fields) {
      if (field in agent) {
        delete agent[field];
        handled.push({ kind, field });
      }
    }
  };
  strip(LIFECYCLE_FIELDS, 'lifecycle');
  strip(LOCAL_FIELDS, 'local_pref');

  for (const field of HOST_ONLY_FIELDS) {
    if (field in agent) {
      blockers.push({ rule: 'agent.host_only', field, message: `host-only field ${field} cannot be distributed` });
    }
  }
  const runtime = agent.runtime as { kind?: unknown } | undefined;
  if (runtime && runtime.kind !== 'in_process') {
    blockers.push({ rule: 'agent.runtime_not_distributable', field: 'runtime', message: 'only in_process agents can be distributed' });
  }
  // 本机自建 Agent 的 `interface_contract` 由运行时自动派生（`in_process`），不是作者定义，剥离即可；
  // 只有它声明了 `in_process` 以外的运行时（外接 CLI Agent）才阻断。
  if ('interface_contract' in agent) {
    const contract = agent.interface_contract as { runtime?: { kind?: unknown } } | null | undefined;
    if (contract && typeof contract === 'object' && contract.runtime?.kind === 'in_process') {
      delete agent.interface_contract;
      handled.push({ kind: 'derived', field: 'interface_contract' });
    } else {
      blockers.push({ rule: 'agent.runtime_not_distributable', field: 'interface_contract', message: 'external agents cannot be distributed' });
    }
  }
  if (agent.icon === 'crown') {
    blockers.push({ rule: 'agent.icon_not_distributable', field: 'icon', message: 'the commander icon cannot be distributed' });
  }
  strip(DERIVED_FIELDS, 'derived');
  // 协议里 `skill_list` 可选，但 Hub 的引用解析把"缺省"也当成"不是数组"而拒绝（真 Hub 联调发现）。
  // 没有技能的 Agent 补一个空数组：语义完全等价，也不影响内容摘要之外的任何东西。
  if (!('skill_list' in agent)) agent.skill_list = [];
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = agent[field];
    if (typeof value === 'string' && value.trim() === '') {
      delete agent[field];
      handled.push({ kind: 'empty', field });
    }
  }
  return { agent, handled, blockers };
}

// ── 包上限（四段；数值来自契约，Hub 称 200 的最终值可能调整，故走配置不写死）──────

export interface PackageLimits {
  /** 压缩后字节上限。 */
  maxCompressedBytes: number;
  /** 内容树文件数上限（注意：与 C-03 的「blocking/warnings 各 ≤ 200 条」无关）。 */
  maxFiles: number;
  /** 解包后字节上限。 */
  maxUnpackedBytes: number;
  /** 单条目压缩比上限（解包大小 / 压缩大小）。 */
  maxEntryCompressionRatio: number;
}

/** 默认值取自 Hub 2026-10-12 答复；联调前以契约为准，调用方可传入覆盖值。 */
export const DEFAULT_PACKAGE_LIMITS: Readonly<PackageLimits> = Object.freeze({
  maxCompressedBytes: 8 * 1024 * 1024,
  maxFiles: 200,
  maxUnpackedBytes: 10 * 1024 * 1024,
  maxEntryCompressionRatio: 100,
});

export interface PackageStats {
  /** 压缩后字节数；预览阶段尚未压缩时缺省，打包后再判。 */
  compressedBytes?: number;
  fileCount: number;
  unpackedBytes: number;
  /** 各条目中最大的压缩比；缺省表示尚未压缩。 */
  maxEntryCompressionRatio?: number;
}

export type PackageLimitViolation =
  | { kind: 'compressed_too_large'; actual: number; limit: number }
  | { kind: 'too_many_files'; actual: number; limit: number }
  | { kind: 'unpacked_too_large'; actual: number; limit: number }
  | { kind: 'compression_ratio_too_high'; actual: number; limit: number };

export function checkPackageLimits(
  stats: PackageStats,
  limits: Readonly<PackageLimits> = DEFAULT_PACKAGE_LIMITS,
): PackageLimitViolation[] {
  const out: PackageLimitViolation[] = [];
  if (stats.compressedBytes !== undefined && stats.compressedBytes > limits.maxCompressedBytes) {
    out.push({ kind: 'compressed_too_large', actual: stats.compressedBytes, limit: limits.maxCompressedBytes });
  }
  if (stats.fileCount > limits.maxFiles) {
    out.push({ kind: 'too_many_files', actual: stats.fileCount, limit: limits.maxFiles });
  }
  if (stats.unpackedBytes > limits.maxUnpackedBytes) {
    out.push({ kind: 'unpacked_too_large', actual: stats.unpackedBytes, limit: limits.maxUnpackedBytes });
  }
  if (stats.maxEntryCompressionRatio !== undefined && stats.maxEntryCompressionRatio > limits.maxEntryCompressionRatio) {
    out.push({ kind: 'compression_ratio_too_high', actual: stats.maxEntryCompressionRatio, limit: limits.maxEntryCompressionRatio });
  }
  return out;
}

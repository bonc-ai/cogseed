/**
 * Personal Ontology Router — 候选确认的"对号入座"LLM 路由。
 *
 * 候选确认时，把候选文本 + 已安装角色模板的字段清单喂给 LLM，让它判断
 * 这条候选应填入哪个模板文件的哪个分节字段（挖空表单的"坑"）；拿不准就进
 * 流水区。
 *
 * 阶段 D 起字段清单来源 = 模板文件（listTemplateFileCatalog，文件是唯一事实
 * 来源：含空坑、自定义字段）；`group_title` 语义 = 模板文件分节名。
 *
 * 可靠性契约（不阻塞用户操作）：
 * - LLM 调用失败 / 返回空 / JSON 解析失败 / 结果不在清单内 → `action: 'flow'`
 *   （候选走流水区，与无路由时行为一致）。
 * - 只做"建议"：最终写入仍由 candidates.ts 的既有路由（有坑填坑/没坑流水）
 *   兜底校验，LLM 不会绕过字段存在性检查。
 *
 * 成本模型：每条候选 ≈ 1 次轻量 LLM 调用（prompt 约 300-600 token）。批量确认
 * 逐条调用；合并批处理留待后续优化（见 candidates.ts 注释）。
 */

import { buildRunner } from '../model/core-agent/runner';
import { createLogger } from '../logger';
import type { TemplateCatalogEntry } from './personal_ontology_template_files';

const log = createLogger('personal-ontology-router');

export interface RouteDecision {
  action: 'field' | 'flow';
  /** 目标模板文件分节名（如「课程」），action=field 时有效。 */
  group_title?: string;
  /** 目标字段名（如「课程名称」），action=field 时有效。 */
  field_name?: string;
  /** 命中置信度：仅 high 允许自动填坑；medium/low 一律回退流水区（防误填污染画像）。 */
  confidence?: 'high' | 'medium' | 'low';
  /**
   * `flow` may be a valid model decision or a recoverable routing failure.
   * Callers that only need a fallback can ignore this field; background profile
   * projection uses it to retry provider/response failures instead of caching them.
   */
  failure?: 'model_unavailable' | 'invalid_response';
}

type BuildRunnerFn = typeof buildRunner;

export interface RouterOptions {
  /** 测试注入：替换 buildRunner（默认用真实 core-agent runner）。 */
  buildRunnerFn?: BuildRunnerFn;
}

/** 从 LLM 回复里抠出 JSON 对象并校验结构；不合法返回 null。 */
export function parseRouteDecision(text: string): RouteDecision | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj && obj.action === 'field' && typeof obj.group_title === 'string' && typeof obj.field_name === 'string') {
      const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'low';
      return { action: 'field', group_title: obj.group_title, field_name: obj.field_name, confidence };
    }
    if (obj && obj.action === 'flow') return { action: 'flow' };
    return null;
  } catch {
    return null;
  }
}

/** 构造路由 prompt：候选文本 + 已安装模板文件的分节字段清单（读文件）。 */
export function buildRoutePrompt(candidateText: string, catalog: TemplateCatalogEntry[]): string {
  const list = catalog
    .map((t) => {
      const sections = t.sections
        .map((s) => `  ${s.title}: [${s.fields.join(', ')}]`)
        .join('\n');
      return `[${t.name}]（${t.template_id}@${t.version}）\n${sections}`;
    })
    .join('\n');

  return `你是个人本体的"对号入座"路由器。候选确认时，要把一条记忆文本填入某个已安装角色模板的字段（挖空表单的坑），或者放流水区。

已安装角色模板的字段清单（分节: [字段...]）：
${list}

规则：
- 判断候选文本能填入哪个模板分节的哪个字段：值语义与字段名匹配才算命中（如"喜欢大白话"→ 偏好.沟通风格；"《知识工程》"→ 课程.课程名称）。
- 命中时给出置信度：非常明确、无歧义 → high；大致匹配但可能二义 → medium；勉强沾边 → low。
- 候选是通用事实/偏好/规则，没有明显对应字段 → 流水区（action: flow）。
- 拿不准一律 flow，不要硬填。
- 只输出一个 JSON 对象，不要任何其他文字或解释。

候选文本：
${String(candidateText || '').slice(0, 500)}

输出格式（三选一）：
{"action":"field","group_title":"课程","field_name":"课程名称","confidence":"high"}
{"action":"field","group_title":"课程","field_name":"课程名称","confidence":"medium"}
{"action":"flow"}`;
}

/**
 * 候选 → LLM 路由。失败/拿不准一律返回 flow（不抛错、不阻塞确认流程）。
 * `catalog` = 已安装模板文件的分节字段清单（listTemplateFileCatalog 产出）。
 */
export async function routeCandidateToField(
  uid: string,
  candidateText: string,
  catalog: TemplateCatalogEntry[],
  opts: RouterOptions = {},
): Promise<RouteDecision> {
  if (!catalog || !catalog.length) return { action: 'flow' };

  const prompt = buildRoutePrompt(candidateText, catalog);
  try {
    const build = opts.buildRunnerFn ?? buildRunner;
    const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const { runner } = await build({ sessionId: `reflect-ontology-route-${tail}`, userId: uid });
    const text = await runner.runReflection(prompt);
    if (!text || !text.trim()) return { action: 'flow', failure: 'invalid_response' };

    const decision = parseRouteDecision(text);
    if (!decision) return { action: 'flow', failure: 'invalid_response' };
    if (decision.action === 'field') {
      // 置信度门禁：仅 high 允许自动填坑；medium/low 回退流水区（防误填污染画像）
      if (decision.confidence !== 'high') {
        log.info('llm route low confidence, falling back to flow', { uid, decision });
        return { action: 'flow' };
      }
      // 校验目标分节/字段确实在已安装模板文件清单内（防 LLM 幻觉）
      const hit = catalog.some((t) =>
        t.sections.some((s) => s.title === decision.group_title && s.fields.includes(decision.field_name)),
      );
      if (!hit) {
        log.warn('llm route returned unknown field, falling back to flow', { uid, decision });
        return { action: 'flow', failure: 'invalid_response' };
      }
    }
    return decision;
  } catch (err) {
    log.warn('llm route failed, falling back to flow', { uid, error: (err as Error).message });
    return { action: 'flow', failure: 'model_unavailable' };
  }
}

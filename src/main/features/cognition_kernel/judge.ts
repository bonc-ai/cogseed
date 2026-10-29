/**
 * cognition_kernel/judge — 认知归属判定与候选入池。
 *
 * 可信生产者给出的显式归属或字段落点可确定性短路，不调用模型。
 * 模型判定始终进入 pending 候选池等待用户确认，置信度只用于排序展示。
 * 最多保留三个归属候选，允许空结果；主候选建 Delta，次候选供确认时选择。
 * 纠正样例按词面相关性检索，判定结果写入 routing-decisions.jsonl 供审计。
 * 模型负责语义判断，代码负责写入门控；判定不直接写用户档案。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { buildRunner } from '../../model/core-agent/runner';
import { createLogger } from '../../logger';
import { userCognitionDir } from '../../paths';
import { nowIso, safeId } from '../../storage';
import { UNCLASSIFIED } from './routing';
import { readRoutingRules, type RoutingCorrection, type RoutingRule, type RoutingRulesDoc } from './routing_rules';
import { loadCognitionStoreSync } from './store';
import type { HomeRegistryEntry } from './object-model';
import type { ContentHome } from './types';

const log = createLogger('cognition-routing-judge');

const MAX_STATEMENT_FOR_PROMPT = 800;
const MAX_ONTOLOGY_CHARS = 1800;
const MAX_RULES_IN_PROMPT = 20;
const MAX_CORRECTIONS_IN_PROMPT = 12;
const MAX_REASON_CHARS = 120;
const MAX_AUDIT_STATEMENT_CHARS = 300;
const MAX_CANDIDATES = 3;

export interface ContentToRoute {
  statement: string;
  /** 生产者给的弱信号（模型建议/来源通道）：只作参考，不作判定依据。 */
  suggestedType?: string;
  sourceKind?: string;
  /**
   * 确定性短路口（可核验信号，不调模型）：可信生产者已确知归属时传入——
   * 例：用户在对话里明说「记住我的部门是…」（explicitHome=personal_fact）、
   * 回填已知字段（fieldName 有明确落点）。闸门只认这类信号，不认自报置信度。
   */
  explicitHome?: ContentHome;
  /** 字段有明确落点 → 断言语义短路（不调模型）。 */
  fieldName?: string;
}

export type RoutingOutcome = 'deterministic' | 'proposed' | 'unclassified';

export interface HomeCandidate {
  home: string;
  confidence: number;
}

export interface RoutingJudgement {
  outcome: RoutingOutcome;
  /** 主候选（outcome='proposed' 时必有；unclassified 为 null）。 */
  home: ContentHome | null;
  /** 全部候选（≤3，按置信度降序）；deterministic 时只有主候选一条。 */
  candidates: HomeCandidate[];
  /** 主候选置信度（仅排序展示，不作闸门）。 */
  confidence: number;
  reason: string;
  matchedRuleIds: string[];
  /** 'rules'=确定性短路；'llm'=模型判定；'degraded'=不可用/不可解析。 */
  model: 'rules' | 'llm' | 'degraded';
}

export interface JudgeOptions {
  /** 测试缝：与 semantic-review 同一手法。 */
  buildRunnerFn?: typeof buildRunner;
  readRulesFn?: (uid: string) => RoutingRulesDoc;
  ontologyContextFn?: (uid: string) => Promise<string>;
  homesFn?: (uid: string) => HomeRegistryEntry[];
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** T-Box + R-Box 摘要：让判定"按本体规则"发生，而不是凭空猜。 */
export async function buildOntologyContext(uid: string): Promise<string> {
  try {
    const [{ loadOntologyTaxonomy }, { loadOntologyRules }] = await Promise.all([
      import('../recall/ontology-taxonomy'),
      import('../recall/ontology-rules'),
    ]);
    const [taxonomy, rules] = await Promise.all([loadOntologyTaxonomy(uid), loadOntologyRules(uid)]);
    const lines: string[] = [];

    const groups = Array.isArray(taxonomy?.groups) ? taxonomy.groups : [];
    if (groups.length) {
      lines.push('分类与字段（T-Box）：');
      for (const group of groups.slice(0, 12)) {
        const fields = (group.fields || []).map((field) => field.name).filter(Boolean).slice(0, 20);
        if (!fields.length) continue;
        lines.push('- ' + clip(group.title, 60) + '：' + fields.join('、'));
      }
    }

    const relationRules = Array.isArray(rules?.rules) ? rules.rules : [];
    if (relationRules.length) {
      lines.push('用户已有的关系规则（R-Box）：');
      for (const rule of relationRules.slice(0, 20)) {
        lines.push('- ' + clip(rule.subject, 40) + ' → ' + clip(rule.relation, 40) + ' → ' + clip(rule.object, 60));
      }
    }

    if (!lines.length) return '（用户尚未建立本体：没有分类字段，也没有关系规则。）';
    return lines.join('\n').slice(0, MAX_ONTOLOGY_CHARS);
  } catch (error) {
    log.warn('ontology context unavailable; judging without it', {
      uid,
      error: String((error as Error)?.message || error),
    });
    return '（本体上下文读取失败：本次判定缺少本体依据，请如实给低置信度或空候选。）';
  }
}

// ── 纠正样例相关性检索 ─────────────────────────────────────────────────

/** 分词：CJK 拆 2-gram，其余按非字母数字切词——零依赖的词面相关性。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const cjk = compact.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  for (const word of compact.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) tokens.add(word);
  }
  return tokens;
}

/** 按与待判内容的词面重合排序取 top-N（重合同分时新的在前）。 */
export function rankCorrectionsByRelevance(
  statement: string,
  corrections: readonly RoutingCorrection[],
  limit: number = MAX_CORRECTIONS_IN_PROMPT,
): RoutingCorrection[] {
  const query = tokenize(statement);
  if (!query.size) return corrections.slice(-limit).reverse();
  const scored = corrections.map((item, index) => {
    const target = tokenize(item.statement);
    let overlap = 0;
    for (const token of target) if (query.has(token)) overlap += 1;
    const score = overlap / (1 + Math.sqrt(target.size));
    return { item, score, index };
  });
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  return scored.slice(0, limit).map((entry) => entry.item);
}

// ── prompt 与解析（多候选 + 空）─────────────────────────────────────────

export function buildJudgePrompt(input: {
  statement: string;
  suggestedType?: string;
  sourceKind?: string;
  ontology: string;
  homes: readonly HomeRegistryEntry[];
  rules: readonly RoutingRule[];
  corrections: readonly RoutingCorrection[];
}): string {
  const homesText = input.homes.map((entry) => (
    '- ' + entry.home + '（' + entry.label + '）：' + entry.definition
    + (entry.examples.length ? '\n  例：' + entry.examples.join('；') : '')
  )).join('\n');

  const userRules = input.rules.length
    ? input.rules.slice(-MAX_RULES_IN_PROMPT).map((rule) => '- [' + rule.id + '] 归 ' + rule.home + '：' + rule.note).join('\n')
    : '（暂无）';

  const corrections = input.corrections.length
    ? input.corrections
        .map((item) => '- "' + clip(item.statement, 120) + '"：用户把它从 ' + (item.fromHome || '未分类') + ' 改成 ' + item.toHome
          + (item.note ? '（原因：' + item.note + '）' : ''))
        .join('\n')
    : '（暂无）';

  const hints = [
    input.suggestedType ? '生产者建议类型=' + input.suggestedType : '',
    input.sourceKind ? '来源通道=' + input.sourceKind : '',
  ].filter(Boolean).join('，') || '（无）';

  const homeIds = input.homes.map((entry) => entry.home).join('|');

  return [
    '你是「认知归属判定员」。判断下面这条内容该进用户认知的哪个家。',
    '',
    '【家的定义】',
    homesText,
    '',
    '【用户的本体】',
    input.ontology,
    '',
    '【用户自己的归属规则】',
    userRules,
    '',
    '【与这条内容最相关的历史纠正样例】',
    corrections,
    '',
    '【待判内容】',
    clip(input.statement, MAX_STATEMENT_FOR_PROMPT),
    '（参考信号，不构成判据：' + hints + '）',
    '',
    '【输出】只输出一个 JSON 对象，不要解释、不要代码块：',
    '{"candidates":[{"home":"候选家id","confidence":0.0到1.0},…最多' + MAX_CANDIDATES + '条],"reason":"一句话依据（≤60字）","matchedRuleIds":["命中的用户规则id，没有就空数组"]}',
    '规则：candidates 按把握从高到低排；一条内容可能同时像两个家（如"我不吃辣"既像 personal_fact 又像 rule），'
      + '把握接近就都列出来，不要硬选一个；完全不属于任何家（闲聊/问候/一次性请求）就给空数组——如实报告，不要猜。',
    '可用的家 id：' + homeIds + '（都不合适 → 空数组）。',
  ].join('\n');
}

/** 解析模型回复：宽松取第一个 JSON 对象；candidates 严格收口（≤3、合法家、按置信度降序）。 */
/**
 * 从模型回复中提取判词 JSON 对象。此提取部分适配自 Mem0 的
 * removeCodeBlocks / extractJson，按 Apache-2.0 保留上游许可与署名：
 * Copyright [2023] [Taranjeet Singh]
 * https://github.com/mem0ai/mem0/blob/abb81c88e1f738a8117d8293530fbc31a5ef8fd9/mem0-ts/src/oss/src/prompts/index.ts#L744-L904
 * 许可全文：LICENSES/Apache-2.0.txt；来源说明：THIRD_PARTY_NOTICES.md。
 * 本地修改：仅接收对象，最多收集 8 个，优先取含判词键的对象，失败返回 null。
 * 三层容错：剥 <think>/代码围栏 → 字符串与转义感知的花括号深度扫描 → 判词键优先。
 * 全部失败返回 null——判词解析失败按 unclassified 处理，不猜。
 */
function extractJudgeObject(text: string): Record<string, unknown> | null {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[a-zA-Z]*\n?/g, ' ')
    .replace(/```/g, ' ');
  const found: Record<string, unknown>[] = [];
  for (let start = cleaned.indexOf('{'); start !== -1 && found.length < 8; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(cleaned.slice(start, i + 1));
            if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value as Record<string, unknown>);
          } catch { /* 这个起点的片段不合法，换下一个 '{' */ }
          break;
        }
      }
    }
  }
  return found.find(o => Array.isArray(o.candidates) || typeof o.reason === 'string') ?? found[0] ?? null;
}

export function parseJudgeReply(
  text: string,
  knownHomes: ReadonlySet<string>,
): { candidates: HomeCandidate[]; confidence: number; reason: string; matchedRuleIds: string[] } | null {
  const raw = extractJudgeObject(text);
  if (!raw) return null;
  const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const seen = new Set<string>();
  const candidates: HomeCandidate[] = [];
  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const home = String(r.home ?? '').trim();
    if (!home || home === UNCLASSIFIED || !knownHomes.has(home) || seen.has(home)) continue;
    seen.add(home);
    const rawConfidence = Number(r.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;
    candidates.push({ home, confidence });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const reason = clip(raw.reason, MAX_REASON_CHARS);
  const matchedRuleIds = Array.isArray(raw.matchedRuleIds)
    ? raw.matchedRuleIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
    : [];
  return { candidates, confidence: candidates[0]?.confidence ?? 0, reason, matchedRuleIds };
}

/** 判定一条内容该进哪个家。永不抛错：失败一律回退为 unclassified。 */
export async function judgeContentHome(
  uid: string,
  content: ContentToRoute,
  options: JudgeOptions = {},
): Promise<RoutingJudgement> {
  const statement = clip(content?.statement, MAX_STATEMENT_FOR_PROMPT);
  if (!safeId(uid) || !statement) {
    return { outcome: 'unclassified', home: null, candidates: [], confidence: 0, reason: '内容为空或用户无效', matchedRuleIds: [], model: 'degraded' };
  }

  // 确定性短路（可核验信号，不调模型）。
  const homes = options.homesFn ? options.homesFn(uid) : loadCognitionStoreSync(uid).homes;
  const knownHomes = new Set(homes.map((entry) => entry.home));
  if (content.explicitHome && knownHomes.has(content.explicitHome)) {
    const judgement: RoutingJudgement = {
      outcome: 'deterministic',
      home: content.explicitHome,
      candidates: [{ home: content.explicitHome, confidence: 1 }],
      confidence: 1,
      reason: '可信生产者显式声明（不调模型）',
      matchedRuleIds: [],
      model: 'rules',
    };
    void recordRoutingDecision(uid, { content: statement, judgement });
    return judgement;
  }
  if (content.fieldName && knownHomes.has('personal_fact')) {
    const judgement: RoutingJudgement = {
      outcome: 'deterministic',
      home: 'personal_fact',
      candidates: [{ home: 'personal_fact', confidence: 1 }],
      confidence: 1,
      reason: '字段有明确落点（' + clip(content.fieldName, 40) + '）→ 断言语义，不调模型',
      matchedRuleIds: [],
      model: 'rules',
    };
    void recordRoutingDecision(uid, { content: statement, judgement });
    return judgement;
  }

  try {
    const readRules = options.readRulesFn ?? readRoutingRules;
    const buildContext = options.ontologyContextFn ?? buildOntologyContext;
    const [rulesDoc, ontology] = await Promise.all([Promise.resolve(readRules(uid)), buildContext(uid)]);

    const build = options.buildRunnerFn ?? (await import('../../model/core-agent/runner')).buildRunner;
    const tail = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const { runner } = await build({
      sessionId: 'cognition-routing-judge-' + tail,
      userId: uid,
    });
    const reply = await runner.runReflection(buildJudgePrompt({
      statement,
      ontology,
      homes,
      rules: rulesDoc.rules,
      corrections: rankCorrectionsByRelevance(statement, rulesDoc.corrections),
      ...(content.suggestedType ? { suggestedType: String(content.suggestedType) } : {}),
      ...(content.sourceKind ? { sourceKind: String(content.sourceKind) } : {}),
    }));
    const parsed = parseJudgeReply(reply || '', knownHomes);
    if (!parsed) {
      log.warn('routing judge reply unparseable', { uid });
      const judgement: RoutingJudgement = { outcome: 'unclassified', home: null, candidates: [], confidence: 0, reason: '模型回复不可解析', matchedRuleIds: [], model: 'degraded' };
      void recordRoutingDecision(uid, { content: statement, judgement });
      return judgement;
    }
    const judgement: RoutingJudgement = parsed.candidates.length
      ? {
          outcome: 'proposed',
          home: parsed.candidates[0].home as ContentHome,
          candidates: parsed.candidates,
          confidence: parsed.candidates[0].confidence,
          reason: parsed.reason,
          matchedRuleIds: parsed.matchedRuleIds,
          model: 'llm',
        }
      : {
          outcome: 'unclassified',
          home: null,
          candidates: [],
          confidence: 0,
          reason: parsed.reason || '模型判定为空（不属于任何家）',
          matchedRuleIds: parsed.matchedRuleIds,
          model: 'llm',
        };
    void recordRoutingDecision(uid, { content: statement, judgement });
    return judgement;
  } catch (error) {
    log.warn('routing judge unavailable', { uid, error: String((error as Error)?.message || error) });
    return { outcome: 'unclassified', home: null, candidates: [], confidence: 0, reason: '判定不可用', matchedRuleIds: [], model: 'degraded' };
  }
}

/** 判定留痕（best-effort）：可审计、可回放，也是将来评测判定的数据来源。 */
export async function recordRoutingDecision(
  uid: string,
  record: { content: string; judgement: RoutingJudgement },
): Promise<void> {
  if (!safeId(uid)) return;
  try {
    const file = path.join(userCognitionDir(uid), 'routing-decisions.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      at: nowIso(),
      content: clip(record.content, MAX_AUDIT_STATEMENT_CHARS),
      outcome: record.judgement.outcome,
      home: record.judgement.home,
      candidates: record.judgement.candidates,
      reason: clip(record.judgement.reason, MAX_REASON_CHARS),
      matchedRuleIds: record.judgement.matchedRuleIds,
      model: record.judgement.model,
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (error) {
    log.warn('routing decision not recorded', { uid, error: String((error as Error)?.message || error) });
  }
}

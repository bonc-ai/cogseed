import { loadOntologyRules, type OntologyRule } from './ontology-rules';
import { loadOntologyTaxonomy, type OntologyTaxonomy } from './ontology-taxonomy';

/**
 * The task contract is deliberately a query description, not a second task
 * planner.  It is built from bounded user-provided text and the current
 * ontology vocabulary so recall can explain which deterministic signals it
 * used without asking a model to interpret the task.
 */
export interface RecallTaskContract {
  goal: string;
  tokens: string[];
  objects: string[];
  actionType: 'analyze' | 'generate' | 'modify' | 'execute' | 'verify' | 'unknown';
  constraints: string[];
  requiredCapabilities: string[];
  ontologyAnchors: Array<{ groupId: string; field?: string; score: number }>;
}

export interface RecallTaskContractInput {
  taskText?: string;
  purpose?: string;
  workspaceId?: string;
}

export interface RecallTaskContractContext {
  contract: RecallTaskContract;
  taxonomy: OntologyTaxonomy;
  rules: OntologyRule[];
  /** True when one of the ontology readers was unavailable. */
  degraded: boolean;
}

const MAX_INPUT_LENGTH = 2_000;
const MAX_GOAL_LENGTH = 2_000;
const MAX_TOKENS = 64;
const MAX_OBJECTS = 16;
const MAX_CONSTRAINTS = 12;
const MAX_CAPABILITIES = 12;
const MAX_ANCHORS = 48;
const MAX_TERM_LENGTH = 200;
const ONTOLOGY_ANCHOR_THRESHOLD = 0.7;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'the', 'to', 'use', 'with', 'this', 'that',
  'please', 'only', 'must', 'should', '当前', '本次', '这个', '进行', '以及', '并且',
  '请', '的', '和', '与', '在', '对', '把', '将', '并', '及', '一下',
]);

const ACTION_PATTERNS: Array<[
  RecallTaskContract['actionType'],
  RegExp,
]> = [
  ['analyze', /分析|审查|评审|研究|理解|解释|诊断|\banaly[sz]e?\b|\breview\b|\binspect\b|\bstudy\b/i],
  ['generate', /生成|创建|撰写|起草|设计|产出|\bgenerate\b|\bcreate\b|\bdraft\b|\bwrite\b/i],
  ['modify', /修改|编辑|重构|更新|优化|修复|改动|\bmodify\b|\bedit\b|\brefactor\b|\bupdate\b|\bfix\b/i],
  ['execute', /执行|运行|部署|发布|调用|实施|\bexecute\b|\brun\b|\bdeploy\b|\bapply\b/i],
  ['verify', /验证|校验|测试|确认|核验|检查|\bverify\b|\bvalidate\b|\btest\b|\bcheck\b/i],
];

const CAPABILITY_WORDS = new Set([
  'api', 'cli', 'code', 'database', 'db', 'filesystem', 'file', 'http', 'oauth',
  'query', 'sql', 'tool', 'web', 'workspace', '代码', '数据库', '文件', '接口',
  '工具', '网络', '权限', '回调', '令牌', 'token', 'callback',
]);

function boundedText(value: unknown, max = MAX_INPUT_LENGTH): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function compact(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Extract words and small CJK n-grams.  We retain complete CJK runs for
 * exact phrase matches, while the bounded bigrams let "当前项目的规则" match
 * the vocabulary term "当前项目规则" without a language-specific tokenizer.
 */
function lexicalTokens(value: string, max = MAX_TOKENS): string[] {
  const normalized = boundedText(value).toLocaleLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => {
    const normalizedToken = token.trim();
    if (!normalizedToken || STOP_WORDS.has(normalizedToken) || seen.has(normalizedToken)) return;
    seen.add(normalizedToken);
    out.push(normalizedToken);
  };

  for (const match of normalized.match(/[a-z0-9][a-z0-9_/-]*/g) || []) add(match);
  for (const match of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    if (match.length <= 24) add(match);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= match.length; index += 1) {
        add(match.slice(index, index + size));
        if (out.length >= max) return out.slice(0, max);
      }
    }
  }
  return out.slice(0, max);
}

function phraseScore(query: string, term: string): number {
  const queryText = boundedText(query).toLocaleLowerCase();
  const termText = boundedText(term, MAX_TERM_LENGTH).toLocaleLowerCase();
  if (!queryText || !termText) return 0;
  const queryCompact = compact(queryText);
  const termCompact = compact(termText);
  if (termCompact.length >= 2 && queryCompact.includes(termCompact)) return 1;

  const termTokens = lexicalTokens(termText, 24);
  if (!termTokens.length) return 0;
  const queryTokens = new Set(lexicalTokens(queryText, MAX_TOKENS));
  const hits = termTokens.filter((token) => queryTokens.has(token)).length;
  if (!hits) return 0;
  // A partial vocabulary hit is still deterministic evidence, but it must be
  // materially stronger than a generic substring before it can select an
  // asset on its own.
  return Number((0.5 + (0.5 * hits) / termTokens.length).toFixed(6));
}

function unique(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, max);
}

function actionTypeFor(goal: string): RecallTaskContract['actionType'] {
  let selected: { type: RecallTaskContract['actionType']; index: number } | undefined;
  for (const [type, pattern] of ACTION_PATTERNS) {
    const match = pattern.exec(goal);
    if (!match) continue;
    const index = match.index;
    if (!selected || index < selected.index) selected = { type, index };
  }
  return selected?.type || 'unknown';
}

function extractConstraints(goal: string): string[] {
  const patterns = [
    /(?:must|only|should|without|avoid|when|unless|禁止|必须|仅限|只能|不得|不要|避免|在[^，。；;]{0,30}(?:时|情况下))[^。；;.!?\n]{0,160}/giu,
  ];
  const constraints: string[] = [];
  for (const pattern of patterns) {
    for (const match of goal.matchAll(pattern)) constraints.push(boundedText(match[0], 160));
  }
  return unique(constraints, MAX_CONSTRAINTS);
}

function extractObjects(tokens: string[], actionType: RecallTaskContract['actionType']): string[] {
  const actionTokens = new Set([
    actionType,
    ...ACTION_PATTERNS.flatMap(([, pattern]) => pattern.source.split('|')),
  ]);
  return unique(tokens.filter((token) => (
    token.length >= 2
    && !STOP_WORDS.has(token)
    && !actionTokens.has(token)
    && !/^(must|only|should|without|avoid|when|unless)$/.test(token)
  )), MAX_OBJECTS);
}

function extractCapabilities(tokens: string[], actionType: RecallTaskContract['actionType']): string[] {
  const capabilities = tokens.filter((token) => CAPABILITY_WORDS.has(token));
  if (actionType !== 'unknown') capabilities.unshift(actionType);
  return unique(capabilities, MAX_CAPABILITIES);
}

function addAnchor(
  anchors: Map<string, { groupId: string; field?: string; score: number }>,
  groupId: string,
  score: number,
  field?: string,
): void {
  if (!groupId || score < ONTOLOGY_ANCHOR_THRESHOLD) return;
  const normalizedField = boundedText(field, MAX_TERM_LENGTH);
  const key = `${groupId}\0${normalizedField}`;
  const existing = anchors.get(key);
  if (!existing || score > existing.score) {
    anchors.set(key, {
      groupId,
      ...(normalizedField ? { field: normalizedField } : {}),
      score: Number(score.toFixed(6)),
    });
  }
}

function ontologyAnchorsFor(
  goal: string,
  taxonomy: OntologyTaxonomy,
  rules: OntologyRule[],
): RecallTaskContract['ontologyAnchors'] {
  const anchors = new Map<string, { groupId: string; field?: string; score: number }>();
  for (const group of taxonomy.groups) {
    addAnchor(anchors, group.groupId, phraseScore(goal, group.title));
    for (const field of group.fields) {
      addAnchor(anchors, group.groupId, phraseScore(goal, field.name), field.name);
    }
  }
  for (const rule of rules) {
    const score = Math.max(
      phraseScore(goal, rule.groupTitle),
      phraseScore(goal, rule.field),
      phraseScore(goal, rule.subject),
      phraseScore(goal, rule.object),
    );
    addAnchor(anchors, rule.groupId, score, rule.field);
  }
  return [...anchors.values()]
    .sort((left, right) => right.score - left.score
      || left.groupId.localeCompare(right.groupId)
      || (left.field || '').localeCompare(right.field || ''))
    .slice(0, MAX_ANCHORS);
}

function buildContract(
  input: RecallTaskContractInput,
  taxonomy: OntologyTaxonomy,
  rules: OntologyRule[],
): RecallTaskContract {
  const taskText = boundedText(input.taskText);
  const purpose = boundedText(input.purpose, 500);
  const goal = [taskText, purpose].filter(Boolean).join('\n').slice(0, MAX_GOAL_LENGTH);
  const tokens = lexicalTokens(goal);
  const actionType = actionTypeFor(goal);
  return {
    goal,
    tokens,
    objects: extractObjects(tokens, actionType),
    actionType,
    constraints: extractConstraints(goal),
    requiredCapabilities: extractCapabilities(tokens, actionType),
    ontologyAnchors: ontologyAnchorsFor(goal, taxonomy, rules),
  };
}

/** Load ontology context and build a contract without mutating any ontology data. */
export async function loadRecallTaskContractContext(
  userId: string,
  input: RecallTaskContractInput = {},
): Promise<RecallTaskContractContext> {
  const [taxonomyResult, rulesResult] = await Promise.allSettled([
    loadOntologyTaxonomy(userId),
    loadOntologyRules(userId, input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  ]);
  const taxonomy = taxonomyResult.status === 'fulfilled' ? taxonomyResult.value : { groups: [] };
  const rules = rulesResult.status === 'fulfilled' ? rulesResult.value.rules : [];
  return {
    contract: buildContract(input, taxonomy, rules),
    taxonomy,
    rules,
    degraded: taxonomyResult.status === 'rejected' || rulesResult.status === 'rejected',
  };
}

export async function buildRecallTaskContract(
  userId: string,
  input: RecallTaskContractInput = {},
): Promise<RecallTaskContract> {
  return (await loadRecallTaskContractContext(userId, input)).contract;
}

/** Compatibility alias for callers that describe this operation as extraction. */
export const extractRecallTaskContract = buildRecallTaskContract;

export const RECALL_ONTOLOGY_ANCHOR_THRESHOLD = ONTOLOGY_ANCHOR_THRESHOLD;

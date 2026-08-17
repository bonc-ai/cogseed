export type RecallCaptureValueSignal =
  | 'preference'
  | 'rule'
  | 'decision'
  | 'template'
  | 'method'
  | 'artifact'
  | 'reusable_outcome'
  | 'substantive_exchange'
  | 'manual_selection';

export type RecallCaptureFilterReason =
  | 'trivial_exchange'
  | 'no_result'
  | 'low_reuse_value'
  | 'model_no_candidate'
  | 'candidate_quality';

export interface RecallCaptureScreeningMessage {
  role: 'user' | 'assistant';
  text: string;
  artifacts?: readonly unknown[];
}

export interface RecallCaptureValueScreeningResult {
  eligible: boolean;
  signals: RecallCaptureValueSignal[];
  reason?: Extract<RecallCaptureFilterReason, 'trivial_exchange' | 'no_result' | 'low_reuse_value'>;
}

export interface RecallCaptureCandidateQualityInput {
  judgment: string;
  value: string;
  summary: string;
  uncertainty?: string;
  suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
  suggestedScope: string;
  suggestedAction?: 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
  risk?: 'low' | 'medium' | 'high';
  targetAssetId?: string;
  valueProvided: boolean;
  actionProvided: boolean;
}

export type RecallCaptureCandidateQualityReason =
  | 'missing_value'
  | 'missing_action'
  | 'missing_scope'
  | 'missing_target'
  | 'missing_user_evidence'
  | 'candidate_too_short'
  | 'value_not_explanatory'
  | 'candidate_not_reusable'
  | 'platitude_no_specifics';

export type RecallCaptureAutomaticIneligibilityReason =
  | RecallCaptureCandidateQualityReason
  | 'assistant_only_evidence'
  | 'missing_durable_user_intent'
  | 'one_off_request'
  | 'vague_user_evidence'
  | 'artifact_without_reuse_intent'
  | 'candidate_not_supported_by_user_intent'
  | 'candidate_conflicts_with_user_intent'
  | 'candidate_scope_not_supported_by_user_intent'
  | 'uncertainty_present'
  | 'high_risk_requires_review';

/** 四类资产的归类校验（PRD 3.1 / 3.2 / 3.3 的硬边界）。
 *
 *  提示词只能"要求"模型按四类定义分类，不能保证。这一层是确定性兜底：
 *  模型把项目事实标成 personal、把原文件标成 template、把一句能力自述标成
 *  skill_method 时，在候选入池前就降级，而不是等它变成正式资产之后再治理。
 *
 *  blocking 与 advisory 分开：blocking 是 PRD 明确排除的内容（有具体反例），
 *  advisory 是"结构不完整但 PRD 未冻结如何处置"的情况（RuleAsset 边界缺失
 *  属于此类，等 Q1 决策），advisory 不阻断，只如实记录。 */
export type RecallCandidateClassificationReason =
  | 'personal_is_project_fact'
  | 'template_not_reusable_structure'
  | 'skill_not_executable'
  | 'rule_missing_boundary'
  | 'personal_not_stable'
  | 'skill_shape_incomplete'
  | 'judgment_is_meta_commentary'
  | 'type_conflicts_with_existing';

export interface RecallCandidateClassificationResult {
  /** 仅由 blocking 原因决定。false → 候选不得进入 pending_review。 */
  ok: boolean;
  blockingReasons: RecallCandidateClassificationReason[];
  advisoryReasons: RecallCandidateClassificationReason[];
}

export interface RecallCaptureCandidateQualityResult {
  reviewable: boolean;
  reasons: RecallCaptureCandidateQualityReason[];
  automaticEligible: boolean;
  automaticIneligibilityReasons: RecallCaptureAutomaticIneligibilityReason[];
}

const TRIVIAL_USER_PATTERNS = [
  /^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|hello|hi|hey)[\s!！,.，。?？]*$/i,
  /^(?:谢谢|多谢|感谢|辛苦了|thanks|thank you|thx)[\s!！,.，。?？]*$/i,
  /^(?:好|好的|可以|行|没问题|收到|明白|知道了|嗯|嗯嗯|确认|同意|ok|okay|sure|got it|fine|yes|no)[\s!！,.，。?？]*$/i,
  /^(?:现在)?(?:到哪(?:个)?阶段(?:了)?|进展(?:如何|怎么样)?|状态(?:如何|怎么样)?|做完了吗|完成了吗|好了吗|还有多久)[\s!！,.，。?？]*$/i,
  /^(?:where are we|what(?:'s| is) the status|status|progress|is it done|are we done|how long)[\s!！,.，。?？]*$/i,
];

const NO_RESULT_PATTERN = /(?:无法(?:完成|生成|获取|访问|处理)|不能(?:完成|生成|获取|访问|处理)|未能(?:完成|生成|获取|访问|处理)|没有(?:完成|生成|找到|获取)|执行失败|处理失败|生成失败|出错了|需要更多信息|无法继续|\b(?:could not|couldn't|cannot|can't|unable to|failed to|need more information|not completed)\b)/i;

const SIGNAL_PATTERNS: ReadonlyArray<readonly [RecallCaptureValueSignal, RegExp]> = [
  ['preference', /(?:偏好|习惯|倾向|希望以后|以后请|我喜欢|我希望|好み|希望|今後.+してほしい|\b(?:prefer|preference|from now on|i like|i want future|minha preferência|prefiro|gosto de|não gosto de)\b)/i],
  ['rule', /(?:必须|务必|不要|禁止|始终|永远|默认|只允许|规则|原则|约束|要求|必ず|禁止|常に|毎回|デフォルト|ルール|\b(?:must|never|always|rule|principle|constraint|by default|required|deve|obrigatório|nunca|sempre|por padrão|regra)\b)/i],
  ['decision', /(?:决定|确定采用|选择使用|最终选择|结论是|批准|同意使用|就按.+(?:做|执行)|\b(?:decided|decision|selected|chose|approved|agreed to use)\b)/i],
  ['template', /(?:模板|格式|结构|字段|清单|范例|示例|固定栏目|テンプレート|形式|構成|項目|チェックリスト|\b(?:template|format|structure|schema|fields?|checklist|example|modelo|formato|estrutura|campos?)\b)/i],
  ['method', /(?:方法|流程|步骤|工作流|操作顺序|先.+再|校验|验证|复用|排查顺序|手順|方法|ワークフロー|検証|確認|再利用|\b(?:method|workflow|procedure|steps?|first.+then|validate|verify|reuse|método|processo|procedimento|etapas|validar|verificar|reutilizar)\b)/i],
  ['reusable_outcome', /(?:已(?:完成|实现|修复|生成|创建|输出|整理|更新|合并|验证|校验)|(?:完成|生成|输出|实现|修复|更新)(?:了|如下)|\b(?:completed|implemented|fixed|generated|created|produced|updated|merged|validated)\b)/i],
];

type DurableIntentKind = RecallCaptureCandidateQualityInput['suggestedType'];

const FUTURE_OR_REUSE_INTENT_PATTERN = /(?:以后|今后|后续|未来|从现在起|每次|始终|永远|默认|一律|长期|持续|固定|反复|复用|重复使用|通用|标准(?:化|模板|格式|流程)|今後|これから|以後|毎回|常に|必ず|標準|長期|再利用|繰り返し|すべて|\b(?:from now on|in future|future|every time|always|default|reus(?:e|able)|repeat(?:ed|able)? use|standard(?:ized)?|long[- ]term|daqui em diante|de agora em diante|no futuro|toda vez|cada vez|sempre|por padrão|reutiliz\w*|longo prazo)\b)/i;
const STABLE_PREFERENCE_PATTERN = /(?:我(?:的)?(?:偏好|习惯|倾向)|我(?:不)?喜欢|我希望(?:以后|今后|后续|未来)|私(?:の)?好み|今後.+(?:してほしい|してください)|\b(?:my preference|i prefer|i (?:do not|don't) like|minha preferência|prefiro|gosto de|não gosto de)\b)/i;
const RULE_PATTERN = /(?:必须|务必|不要|禁止|所有|每(?:次|个)|任何|默认|始终|永远|一律|必ず|禁止|毎回|すべて|常に|デフォルト|必要|\b(?:must|never|always|every|any|default|required|deve|devem|obrigatório|nunca|sempre|todo|toda|cada|qualquer|por padrão)\b)/i;
const TEMPLATE_PATTERN = /(?:模板|格式|结构|字段|清单|范例|示例|固定栏目|テンプレート|形式|構成|項目|チェックリスト|\b(?:template|format|structure|schema|fields?|checklist|modelo|formato|estrutura|campos?)\b)/i;
const METHOD_PATTERN = /(?:方法|流程|步骤|工作流|操作顺序|校验|验证|排查顺序|方法|手順|ワークフロー|検証|確認|\b(?:method|workflow|procedure|steps?|validate|verify|método|processo|procedimento|etapas|validar|verificar)\b)/i;
const ONE_OFF_REQUEST_PATTERN = /(?:帮我|请(?:帮我)?|麻烦|能否|可以(?:帮我)?|需要(?:你)?|\b(?:please|can you|could you|help me)\b).{0,80}(?:整理|生成|创建|转(?:成|为)|改(?:成|为)|分析|修复|处理|写|做|看(?:一下)?|转换|\b(?:organize|create|generate|turn|convert|analy[sz]e|fix|process|write|make|review)\b)/i;

// —— 归类校验用的模式 ——
// 项目/任务事实：PRD 3.4 要求它们留在 Workspace / Project 支撑记录，不进
// PersonalOntologyAsset。典型："我今天在修 KSTAR"、"这个 Sprint 截止 8/19"。
const PROJECT_FACT_PATTERN = /(?:今天|今日|昨天|明天|本周|这周|下周|本月|这次|本次|当前|目前|正在|眼下|这个(?:迭代|冲刺|阶段|版本|项目|需求)|本(?:轮|期|阶段|迭代)|截止|deadline|由\S{1,8}负责|负责人是|会议|日程|排期|\bsprint\b|\bmilestone\b|\btoday\b|\bthis (?:week|month|sprint|iteration|release)\b|\bdue\b|\bhoje\b|\besta semana\b)/i;
// 长期稳定性标记：有这些才算"关于我"，否则多半是一次性状态。
const LONG_TERM_PATTERN = /(?:长期|一直|向来|一贯|通常|一般|习惯(?:上|于)?|总是|每次都|我的风格|我倾向|我偏好|长年|多年|常年|いつも|普段|長期|\b(?:long[- ]term|usually|generally|typically|habitually|always|by habit|tend to|my style)\b)/i;
// 可复用结构：Template 必须是"结构"，不是文件本身，也不是某次实例。
const REUSABLE_STRUCTURE_PATTERN = /(?:模板|范式|骨架|框架|结构|章节|栏目|字段|清单|检查表|checklist|条目|格式|schema|占位|slots?|大纲|提纲|テンプレート|構成|項目|チェックリスト|\b(?:template|skeleton|outline|sections?|fields?|placeholders?|structure|checklist|boilerplate|modelo|estrutura|seções|campos)\b)/i;
// 原文件 / 实例化信息：PRD 3.2 明确它们保持 CognitionSource 身份。
const RAW_ARTIFACT_PATTERN = /(?:\.(?:docx?|xlsx?|pptx?|pdf|md|txt|csv|png|jpe?g|zip)\b|这(?:份|个)(?:文件|文档|附件)|上传的(?:文件|文档)|附件本身|\b(?:uploaded file|attached file|this document)\b)/i;
// Skill 的五项可执行要素（PRD 8.2 Goal/Trigger/Input/Action Plan/Output/Evaluation）。
const SKILL_TRIGGER_PATTERN = /(?:当\S{0,20}(?:时|时候)|遇到|一旦|如果|若|触发|适用于|什么时候用|进入\S{0,10}阶段|\b(?:when|whenever|if|trigger|use when|applies to)\b)/i;
const SKILL_INPUT_PATTERN = /(?:输入|需要提供|先准备|前置|所需(?:材料|信息|资料)|依赖|参数|\b(?:input|requires?|prerequisite|given|parameters?)\b)/i;
const SKILL_PLAN_PATTERN = /(?:步骤|流程|先\S{1,20}(?:再|然后|接着)|第一步|依次|按顺序|工作流|\d\s*[.、)]\s*\S|手順|\b(?:steps?|workflow|procedure|first.{0,30}then|process)\b)/i;
const SKILL_OUTPUT_PATTERN = /(?:输出|产出|交付|结果是|生成\S{0,10}(?:文档|报告|清单|结论)|\b(?:output|deliverable|produces?|results? in)\b)/i;
const SKILL_EVALUATION_PATTERN = /(?:验收|校验|验证|检查|通过条件|判断标准|评价|质量要求|自检|复核|\b(?:validate|verify|check|acceptance|criteria|evaluation|quality gate)\b)/i;
// 能力自述：只声明"我会 X"，没有任何可执行结构。
// 元评论：整句都在评价"这条候选值不值得留"，而不是给出可复用的内容本身。
// 实测样本：「有用且可复用」「有用，体现用户对智能体的期望行为」。
// 只匹配整句——正文里出现"值得沉淀"这类词是正常的，不该误伤。
const META_COMMENTARY_PATTERN = /^(?:很)?(?:有用|有价值|有帮助|值得(?:保存|沉淀|保留|记住)|可复用|能复用|重要)(?:[、,，和与及]?(?:且|并|而且|同时)?(?:很)?(?:有用|有价值|有帮助|值得(?:保存|沉淀|保留|记住)|可复用|能复用|重要|通用))*[\s。.!！]*(?:[，,]\s*(?:体现|说明|反映|表明|符合)[^。.!！]{0,40})?[\s。.!！]*$/i;

const CAPABILITY_CLAIM_PATTERN = /^(?:我(?:很)?(?:擅长|会|能|熟悉|精通|拿手)|\b(?:i(?:'m| am) (?:good at|skilled|experienced)|i can)\b)/i;

function pushUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}

function normalized(value: string): string {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function meaningfulLength(value: string): number {
  return [...normalized(value).replace(/[\p{P}\p{S}\s]/gu, '')].length;
}

function isTrivialUserText(value: string): boolean {
  const text = normalized(value);
  return !text || TRIVIAL_USER_PATTERNS.some((pattern) => pattern.test(text));
}

function collectSignals(messages: readonly RecallCaptureScreeningMessage[]): RecallCaptureValueSignal[] {
  // Only the user's own language may establish durable intent. Assistant text
  // can describe a rule or a successful result, but must not manufacture the
  // reason to keep a conversation as memory.
  const combined = messages.filter((message) => message.role === 'user').map((message) => message.text).join('\n');
  const signals = SIGNAL_PATTERNS
    .filter(([, pattern]) => pattern.test(combined))
    .map(([signal]) => signal);
  if (messages.some((message) => (message.artifacts?.length || 0) > 0)) signals.push('artifact');
  return [...new Set(signals)];
}

/** 套话模式：报告完成/成功，本身不携带可复用知识（需配合具体信号判定）。 */
const PLATITUDE_PATTERN = /(认真完成|按时交付|已完成|完成得不错|顺利完成任务|成功完成|task completed|successfully (completed|delivered|finished)|well done|good (job|work))/i;

function collectTextSignals(text: string): RecallCaptureValueSignal[] {
  return SIGNAL_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([signal]) => signal);
}

function durableIntentKindsForUserMessage(message: RecallCaptureScreeningMessage): DurableIntentKind[] {
  const text = message.text;
  const hasFutureOrReuseIntent = FUTURE_OR_REUSE_INTENT_PATTERN.test(text);
  const kinds: DurableIntentKind[] = [];

  if (STABLE_PREFERENCE_PATTERN.test(text)) pushUnique(kinds, 'personal');
  if (RULE_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'rule');
  if (TEMPLATE_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'template');
  if (METHOD_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'skill_method');

  // A universal or default rule is durable even when it does not say "in the
  // future" literally, for example "所有架构决定必须记录来源".
  if (RULE_PATTERN.test(text) && /(?:所有|每(?:次|个)|任何|默认|始终|永远|一律|\b(?:every|any|always|default)\b)/i.test(text)) {
    pushUnique(kinds, 'rule');
  }

  // A referenced artifact can be written automatically only when the user
  // explicitly gives it a future or reuse role. We infer its concrete type
  // from the candidate rather than treating the attachment alone as intent.
  if ((message.artifacts?.length || 0) > 0 && hasFutureOrReuseIntent) {
    pushUnique(kinds, 'template');
    pushUnique(kinds, 'skill_method');
  }

  return kinds;
}

const LATIN_SUPPORT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'every', 'always', 'must',
  'should', 'default', 'future', 'please', 'uma', 'para', 'com', 'que', 'por', 'cada',
  'sempre', 'deve', 'devem', 'padrão', 'favor', 'todos', 'todas', 'todo', 'toda',
]);
const CJK_SUPPORT_STOP_BIGRAMS = new Set([
  '以后', '今后', '后续', '未来', '所有', '每次', '必须', '默认', '始终', '永远',
  '一律', '模板', '格式', '流程', '方法', '规则', '复用', '使用', '这个', '以上',
  '今後', '毎回', '常に', '必ず', '標準', '再利', '利用', 'すべ', 'べて',
]);

function compactComparableText(value: string): string {
  return normalized(value).replace(/[\p{P}\p{S}\s]/gu, '');
}

function latinContentTokens(value: string): Set<string> {
  const words = normalized(value).match(/[\p{Script=Latin}\p{M}\d]{3,}/gu) || [];
  return new Set(words.filter((word) => !LATIN_SUPPORT_STOP_WORDS.has(word)));
}

function cjkContentBigrams(value: string): Set<string> {
  const bigrams = new Set<string>();
  const sequences = normalized(value).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) || [];
  for (const sequence of sequences) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const bigram = sequence.slice(index, index + 2);
      if (!CJK_SUPPORT_STOP_BIGRAMS.has(bigram)) bigrams.add(bigram);
    }
  }
  return bigrams;
}

function overlapSupports(candidateItems: Set<string>, userItems: Set<string>): boolean {
  if (candidateItems.size < 2 || userItems.size < 2) return false;
  const overlap = [...candidateItems].filter((item) => userItems.has(item)).length;
  return overlap >= 2 && overlap / candidateItems.size >= 0.45;
}

function messageSupportsCandidate(candidateText: string, userText: string): boolean {
  const compactCandidate = compactComparableText(candidateText);
  const compactUser = compactComparableText(userText);
  if (!compactCandidate || !compactUser) return false;
  const shorterLength = Math.min([...compactCandidate].length, [...compactUser].length);
  if (shorterLength >= 8
    && (compactCandidate.includes(compactUser) || compactUser.includes(compactCandidate))) {
    return true;
  }
  return overlapSupports(latinContentTokens(candidateText), latinContentTokens(userText))
    || overlapSupports(cjkContentBigrams(candidateText), cjkContentBigrams(userText));
}

function supportingUserMessages(
  candidate: RecallCaptureCandidateQualityInput,
  userMessages: readonly RecallCaptureScreeningMessage[],
): RecallCaptureScreeningMessage[] {
  return userMessages.filter((message) => messageSupportsCandidate(candidate.judgment, message.text));
}

interface IntentPolarity {
  required: boolean;
  waived: boolean;
  prohibited: boolean;
  permitted: boolean;
}

function intentPolarity(value: string): IntentPolarity {
  const text = normalized(value);
  return {
    required: /(?:必须|务必|需要|应当|始终|每次|一律|必ず|必要|常に|毎回|しなければ|\b(?:must|required|need to|should|always|every time|deve|devem|obrigatório|é necessário|sempre|cada vez)\b)/i.test(text),
    waived: /(?:无需|不必|不用|可不|必要(?:は)?ない|\b(?:need not|do not need|don't need|not required|optional|não precisa|não é necessário|dispensa)\b)/i.test(text),
    prohibited: /(?:不要|禁止|不得|不允许|不能|してはいけない|しないで|\b(?:must not|never|do not|don't|cannot|can't|forbid|prohibit|não deve|não podem|proibido|nunca)\b)/i.test(text),
    permitted: /(?:可以|允许|可直接|してよい|許可|\b(?:may|can|allow|allowed|permitted|pode|podem|permitido)\b)/i.test(text),
  };
}

function candidateConflictsWithUserMessage(candidateText: string, userText: string): boolean {
  const candidate = intentPolarity(candidateText);
  const user = intentPolarity(userText);
  return (candidate.required && user.waived)
    || (candidate.required && user.prohibited)
    || (candidate.waived && user.required)
    || (candidate.prohibited && user.required)
    || (candidate.prohibited && user.permitted)
    || (candidate.permitted && user.prohibited);
}

const GLOBAL_SCOPE_PATTERN = /(?:全局|跨项目|所有项目|任何项目|所有工作区|个人范围|グローバル|すべてのプロジェクト|プロジェクト横断|\b(?:global|all projects|every project|any project|across projects|all workspaces|todos os projetos|qualquer projeto|entre projetos)\b)/i;

function candidateScopeSupportedByUserIntent(
  candidate: RecallCaptureCandidateQualityInput,
  userMessages: readonly RecallCaptureScreeningMessage[],
): boolean {
  const scope = normalized(candidate.suggestedScope);
  const requestsGlobalScope = GLOBAL_SCOPE_PATTERN.test(scope) || scope === 'global';
  if (!requestsGlobalScope) return true;
  if (candidate.suggestedType === 'personal'
    && userMessages.some((message) => STABLE_PREFERENCE_PATTERN.test(message.text))) {
    return true;
  }
  return userMessages.some((message) => GLOBAL_SCOPE_PATTERN.test(message.text));
}

function assessAutomaticEligibility(
  candidate: RecallCaptureCandidateQualityInput,
  evidenceMessages: readonly RecallCaptureScreeningMessage[],
  manualReasons: readonly RecallCaptureCandidateQualityReason[],
): RecallCaptureAutomaticIneligibilityReason[] {
  const reasons: RecallCaptureAutomaticIneligibilityReason[] = [...manualReasons];
  const userMessages = evidenceMessages.filter((message) => message.role === 'user');
  if (!userMessages.length) {
    pushUnique(reasons, 'assistant_only_evidence');
  } else {
    const durableKinds = [...new Set(userMessages.flatMap(durableIntentKindsForUserMessage))];
    if (!durableKinds.length) {
      pushUnique(reasons, 'missing_durable_user_intent');
      if (evidenceMessages.some((message) => (message.artifacts?.length || 0) > 0)) {
        pushUnique(reasons, 'artifact_without_reuse_intent');
      } else if (userMessages.some((message) => ONE_OFF_REQUEST_PATTERN.test(message.text))) {
        pushUnique(reasons, 'one_off_request');
      } else {
        pushUnique(reasons, 'vague_user_evidence');
      }
    } else {
      const supportingMessages = supportingUserMessages(candidate, userMessages);
      if (!durableKinds.includes(candidate.suggestedType) || !supportingMessages.length) {
        pushUnique(reasons, 'candidate_not_supported_by_user_intent');
      } else if (supportingMessages.every((message) => (
        candidateConflictsWithUserMessage(candidate.judgment, message.text)
      ))) {
        pushUnique(reasons, 'candidate_conflicts_with_user_intent');
      }
      if (!candidateScopeSupportedByUserIntent(candidate, userMessages)) {
        pushUnique(reasons, 'candidate_scope_not_supported_by_user_intent');
      }
    }
  }

  if (normalized(candidate.uncertainty || '')) pushUnique(reasons, 'uncertainty_present');
  if (candidate.risk === 'high') pushUnique(reasons, 'high_risk_requires_review');
  return reasons;
}

export function screenRecallCaptureValue(
  messages: readonly RecallCaptureScreeningMessage[],
): RecallCaptureValueScreeningResult {
  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  if (!userMessages.length || !assistantMessages.length) {
    return { eligible: false, signals: [], reason: 'low_reuse_value' };
  }

  const nonTrivialUsers = userMessages.filter((message) => !isTrivialUserText(message.text));
  if (!nonTrivialUsers.length) {
    return { eligible: false, signals: [], reason: 'trivial_exchange' };
  }

  const signals = collectSignals(messages);
  const lastAssistant = assistantMessages.at(-1)!;
  if (
    NO_RESULT_PATTERN.test(lastAssistant.text)
    && !signals.includes('artifact')
    && !signals.includes('reusable_outcome')
  ) {
    return { eligible: false, signals, reason: 'no_result' };
  }

  if (signals.length) return { eligible: true, signals };

  const userLength = nonTrivialUsers.reduce((total, message) => total + meaningfulLength(message.text), 0);
  const totalLength = messages.reduce((total, message) => total + meaningfulLength(message.text), 0);
  const substantive = (userLength >= 48 && totalLength >= 140)
    || (nonTrivialUsers.length >= 2 && userLength >= 36 && totalLength >= 110);
  if (substantive) {
    return { eligible: true, signals: ['substantive_exchange'] };
  }
  return { eligible: false, signals: [], reason: 'low_reuse_value' };
}

/** 归类校验：候选自称的 suggestedType 是否真的成立（PRD 3.1 四类边界）。
 *
 *  只看候选文本与其适用/禁止边界，不看来源——同一来源可以产生多类候选
 *  （PRD 3.2「候选按内容而不是按来源分流」）。 */
export function assessRecallCandidateClassification(
  candidate: RecallCaptureCandidateQualityInput,
  boundaries: {
    applicableWhen?: readonly string[];
    forbiddenWhen?: readonly string[];
    /** 系统里已经存在的、同一 judgment 但类型不同的条目的类型集合。
     *  同一句话不可能既是模板又是方法——出现即说明分类不可信。 */
    conflictingTypes?: readonly string[];
  } = {},
): RecallCandidateClassificationResult {
  const blockingReasons: RecallCandidateClassificationReason[] = [];
  const advisoryReasons: RecallCandidateClassificationReason[] = [];
  const text = `${candidate.judgment}\n${candidate.summary}\n${candidate.value}`;

  // 元评论对四类都不成立：它评价的是"这条候选"，不是任何可复用的认知。
  if (META_COMMENTARY_PATTERN.test(normalized(candidate.judgment))) {
    pushUnique(blockingReasons, 'judgment_is_meta_commentary');
  }

  // 同一 judgment 已经以别的类型存在：两边至少有一边分错了，谁都不该晋升，
  // 留给人判断这句话到底属于哪一类。
  const conflicting = (boundaries.conflictingTypes || []).filter((type) => type && type !== candidate.suggestedType);
  if (conflicting.length) pushUnique(blockingReasons, 'type_conflicts_with_existing');

  if (candidate.suggestedType === 'personal') {
    // 项目事实 + 没有任何长期性标记 → 这是任务状态，不是"关于我"。
    if (PROJECT_FACT_PATTERN.test(text) && !LONG_TERM_PATTERN.test(text)) {
      pushUnique(blockingReasons, 'personal_is_project_fact');
    } else if (!LONG_TERM_PATTERN.test(text) && !STABLE_PREFERENCE_PATTERN.test(text)) {
      // 没写明长期，但也不像项目事实：可能只是措辞省略，交人工判断。
      pushUnique(advisoryReasons, 'personal_not_stable');
    }
  }

  if (candidate.suggestedType === 'template') {
    // 必须是可复用结构；指向原文件本身的不算（PRD 3.2 Artifact 晋升边界）。
    const describesStructure = REUSABLE_STRUCTURE_PATTERN.test(text);
    const pointsAtRawFile = RAW_ARTIFACT_PATTERN.test(text);
    if (!describesStructure || (pointsAtRawFile && !describesStructure)) {
      pushUnique(blockingReasons, 'template_not_reusable_structure');
    }
  }

  if (candidate.suggestedType === 'skill_method') {
    // 这一层只负责拦住"根本不是方法"的东西：能力自述（"我擅长写 PRD"），
    // 以及五项要素一个都沾不上的空壳。完整的 SkillManifest 校验属于 Skill
    // 正式准入（PRD 8.2 Validator + Security Scanner + 最小真实运行验证），
    // 放在候选归类这一层会误伤大量写法正常的方法——例如用逗号连接的
    // "Review the request, apply the method, and validate the result."
    const shape = [
      SKILL_TRIGGER_PATTERN.test(text),
      SKILL_INPUT_PATTERN.test(text),
      SKILL_PLAN_PATTERN.test(text),
      SKILL_OUTPUT_PATTERN.test(text),
      SKILL_EVALUATION_PATTERN.test(text),
    ];
    const present = shape.filter(Boolean).length;
    if (CAPABILITY_CLAIM_PATTERN.test(normalized(candidate.judgment)) || present === 0) {
      pushUnique(blockingReasons, 'skill_not_executable');
    } else if (present < 3) {
      // 结构不完整但不空：留给用户复核，同时给后续 Skill 准入留下记录。
      pushUnique(advisoryReasons, 'skill_shape_incomplete');
    }
  }

  if (candidate.suggestedType === 'rule') {
    // PRD 3.1 要求 RuleAsset 确认适用与禁止范围。自动线目前拿不到这两个值，
    // 如何处置由 Q1 决定，这里先如实记录，不阻断（避免在决策前改变产能）。
    const hasBoundary = (boundaries.applicableWhen?.length || 0) > 0
      && (boundaries.forbiddenWhen?.length || 0) > 0;
    if (!hasBoundary) pushUnique(advisoryReasons, 'rule_missing_boundary');
  }

  return { ok: blockingReasons.length === 0, blockingReasons, advisoryReasons };
}

export function assessRecallCaptureCandidateQuality(
  candidate: RecallCaptureCandidateQualityInput,
  evidenceMessages: readonly RecallCaptureScreeningMessage[],
): RecallCaptureCandidateQualityResult {
  const reasons: RecallCaptureCandidateQualityReason[] = [];
  if (!candidate.valueProvided || meaningfulLength(candidate.value) < 6) reasons.push('missing_value');
  if (!candidate.actionProvided || !candidate.suggestedAction) reasons.push('missing_action');
  if (!normalized(candidate.suggestedScope)) reasons.push('missing_scope');
  if (candidate.suggestedAction
    && ['update', 'limit_scope', 'pause'].includes(candidate.suggestedAction)
    && !candidate.targetAssetId) {
    reasons.push('missing_target');
  }
  if (!evidenceMessages.some((message) => message.role === 'user')) reasons.push('missing_user_evidence');
  if (meaningfulLength(candidate.judgment) < 6 || meaningfulLength(candidate.summary) < 4) {
    reasons.push('candidate_too_short');
  }

  const value = normalized(candidate.value);
  if (value && (value === normalized(candidate.judgment) || value === normalized(candidate.summary))) {
    reasons.push('value_not_explanatory');
  }

  const candidateText = `${candidate.judgment}\n${candidate.summary}\n${candidate.value}`;
  // Candidate wording may establish that the proposed asset is reusable, but
  // it never substitutes for the user evidence check above.
  const candidateSignals = collectTextSignals(candidateText);
  const combinedLength = meaningfulLength(candidateText);
  const hasArtifactEvidence = evidenceMessages.some((message) => (message.artifacts?.length || 0) > 0);
  if (!candidateSignals.length && !hasArtifactEvidence && combinedLength < 40) {
    reasons.push('candidate_not_reusable');
  }

  // 套话闸门（保守版）：judgment 是报告完成/成功的套话，且没有任何具体
  // 信号 → 无复用价值。只拦"纯套话"，不做复述任务判定（模板 judgment
  // 天然含任务词，覆盖率判定误伤面大——上一版已回退）。
  // reusable_outcome（报告完成）与套话天然重叠，不计入有效信号。
  if (PLATITUDE_PATTERN.test(normalized(candidate.judgment))
    && !collectTextSignals(candidate.judgment).some((signal) => signal !== 'reusable_outcome')) {
    reasons.push('platitude_no_specifics');
  }

  const uniqueReasons = [...new Set(reasons)];
  const automaticIneligibilityReasons = assessAutomaticEligibility(candidate, evidenceMessages, uniqueReasons);
  return {
    reviewable: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    automaticEligible: automaticIneligibilityReasons.length === 0,
    automaticIneligibilityReasons,
  };
}

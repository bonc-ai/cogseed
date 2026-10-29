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
  /** 模型显式返回空候选集——它认为这轮没有可沉淀的东西。理由存在
   *  `noCandidateReason`（模型自己给的一句话）。 */
  | 'model_no_candidate'
  /** 模型给出了候选，但全部在逐条解析时被丢弃（字段非法）。这与
   *  `model_no_candidate` 是两件事：前者是"抽对了、确实没有"，后者是
   *  "抽出来了、我们没接住"。合成一个码会让提取质量问题伪装成内容问题。 */
  | 'candidate_unparsable'
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
  suggestedType: 'cognition' | 'personal' | 'rule' | 'template' | 'skill_method' | 'fact';
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
  | 'platitude_no_specifics'
  | 'operation_report_without_insight';

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
  | 'fact_not_stable'
  | 'template_not_reusable_structure'
  | 'skill_not_executable'
  | 'rule_missing_boundary'
  | 'personal_not_stable'
  | 'skill_shape_incomplete'
  | 'judgment_is_meta_commentary'
  | 'type_conflicts_with_existing'
  | 'statement_over_soft_budget';

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
  /^(?:(?:好(?:的)?|收到|明白|嗯)[，,\s]*)?(?:继续|接着(?:做|说)?|continue|go on)[\s!！,.，。?？]*$/i,
];


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
const STABLE_FACT_SUBJECT_PATTERN = /(?:团队|项目|环境|工具链|仓库|服务|系统|域名|版本|技术栈|组织|外部系统|依赖|部署|构建|协作入口|\b(?:team|project|environment|toolchain|repository|service|system|domain|version|stack|organization|external system|dependency|deployment|build|collaboration)\b)/i;
const STABLE_PERSONAL_FACT_PATTERN = /(?:我的(?:名字|姓名|职业|部门|母语|常用语言)(?:是|为)(?!什么|啥|哪)|我(?:长期|一直)从事|\bmy (?:name|occupation|department|native language) is\b|私の(?:名前|職業|部署|母語)は|\b(?:meu nome é|minha profissão é|meu departamento é)\b)/i;
const STABLE_FACT_CHANGE_PATTERN = /(?:从.{0,32}(?:日起|起由|开始)|负责人(?:改为|变更为)|固定.{0,24}(?:接收|负责)|\b(?:effective (?:from|on)|owner changed to|permanent owner|fixed recipients)\b|担当者.{0,16}変更|responsável.{0,16}alterad)/i;
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

  if ((STABLE_PERSONAL_FACT_PATTERN.test(text) && !/[?？]/.test(text)) || STABLE_PREFERENCE_PATTERN.test(text) || (hasFutureOrReuseIntent && /(?:解释|回答|输出|表达|表格|\b(?:explain|respond|answer|format)\b)/i.test(text))) pushUnique(kinds, 'personal');
  if (RULE_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'rule');
  if (TEMPLATE_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'template');
  if (METHOD_PATTERN.test(text) && hasFutureOrReuseIntent) pushUnique(kinds, 'skill_method');
  if (STABLE_FACT_SUBJECT_PATTERN.test(text) && (hasFutureOrReuseIntent || LONG_TERM_PATTERN.test(text) || STABLE_FACT_CHANGE_PATTERN.test(text))) pushUnique(kinds, 'fact');

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
  if ((candidate.suggestedType === 'personal' || candidate.suggestedType === 'cognition')
    && userMessages.some((message) => STABLE_PREFERENCE_PATTERN.test(message.text) || STABLE_PERSONAL_FACT_PATTERN.test(message.text))) {
    return true;
  }
  return userMessages.some((message) => GLOBAL_SCOPE_PATTERN.test(message.text));
}

/** Human-reviewed proposals still need factual support and correct scope. They
 * do not need the explicit long-term authorization required by automatic writes. */
export function isRecallCaptureCandidateGrounded(
  candidate: RecallCaptureCandidateQualityInput,
  evidenceMessages: readonly RecallCaptureScreeningMessage[],
): boolean {
  const users = evidenceMessages.filter(message => message.role === 'user');
  const supporting = supportingUserMessages(candidate, users);
  return supporting.length > 0
    && !supporting.every(message => candidateConflictsWithUserMessage(candidate.judgment, message.text))
    && candidateScopeSupportedByUserIntent(candidate, users)
    && !normalized(candidate.uncertainty || '')
    && !isTaskLocalRuleProposal(candidate, users);
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
      if ((candidate.suggestedType !== 'cognition' && !durableKinds.includes(candidate.suggestedType)) || !supportingMessages.length) {
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

// Initial screening is a shortlist, not a semantic judgment or permission to
// save. Keep its evidence checks separate from candidate typing/write gates.
const SCREEN_TEMPORARY_PATTERN = /(?:这一次|这次|本次|仅(?:限)?本(?:轮|次)|临时|只(?:限)?这次|\b(?:this time|for this (?:task|request|report)|temporary|one[- ]off)\b)/i;
const SCREEN_EXPLICIT_FUTURE_PATTERN = /(?:以后|今后|后续|未来|从(?:今天|现在)起|每次|长期|一直|通常|经常|习惯|默认|始终|一律|反复|复用|重复使用|今後|これから|以後|毎回|常に|デフォルト|\b(?:from now on|in future|future|every time|always|by default|default|usually|reus(?:e|able)|repeat(?:ed|able)? use|long[- ]term|daqui em diante|de agora em diante|no futuro|toda vez|cada vez|sempre|por padrão)\b)/i;
const SCREEN_QUERY_PATTERN = /^(?:请)?(?:查询|查一下|查看|搜索|检索|告诉我|复述|提醒我).*(?:已有|已经|之前|记住|保存|收录|要求|语言|偏好)|^(?:以后|今后)?[^。！？\n]{0,60}(?:是什么|有哪些|用什么|用哪些|怎么样|如何|多少|在哪)[^。！？\n]*[?？]$|^(?:what|which|where|how|do you remember|have you saved)\b/i;
const SCREEN_REQUIREMENT_PATTERN = /(?:要|请|希望|记住|改用|使用|采用|保持|附|交给|审核|回答|解释|讲|核对|区分|需(?:找|由|向|与|给|确认|签字)|不要|不必|不用|必须|禁止|默认|更正|纠正|记错|\b(?:use|keep|remember|must|never|prefer|prepare|create|generate|respond|answer|explain|review|required|correct)\b|してください|必ず|prefiro|deve)/i;
const SCREEN_CORRECTION_PATTERN = /(?:之前|以前|原来|先前).{0,24}(?:记错|说错|理解错)|(?:不是.{1,40}而是|更正|纠正).{1,80}|\b(?:correction|previously mistaken|you (?:misremembered|got .{1,20}wrong))\b/i;
const SCREEN_METHOD_SEQUENCE_PATTERN = /(?:先.{2,50}(?:再|然后|接着).{2,50}|第一步.{2,50}第二步|\b(?:first.{3,60}then|review .{3,60}apply .{3,60}validat)\w*)/i;
const SCREEN_METHOD_CONDITION_PATTERN = /(?:当.{1,40}(?:时|时候)|遇到|如果|若|排查.{1,30}时|适用于|\b(?:when|whenever|if|applies to)\b)/i;
const SCREEN_PRACTICE_PATTERN = /(?:实际|试过|用了|使用后|验证|运行|解决|有效|成功|失败|遗漏|\b(?:tested|worked|resolved|succeeded|failed|after using)\b)/i;
const SCREEN_FEEDBACK_ADOPTION_PATTERN = /(?:采用|改用|决定|以后|反复|经常|限制|只能|不能|不要|\b(?:adopt|decided|recurring|repeated|only|must not)\b)/i;

function screeningUserFragments(text: string): string[] {
  return text.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)|[\n;；]+/)
    .map(fragment => fragment.trim().replace(/[。！.!]+$/, '')).filter(Boolean);
}

function isScreeningQuery(text: string): boolean {
  return SCREEN_QUERY_PATTERN.test(text)
    || /^(?:who|whose|quem|qual)\b|^谁(?:是|负责|签字)/i.test(text)
    || /(?:是谁|由谁|找谁|向谁|是何人)(?:确认|审批|签字|负责|审核|对接)*[\s?？]*$/.test(text)
    || /(?:是|为|由|需找|需要找)[^。！？\n]{1,40}吗[?？]*$/.test(text)
    || /(?:是谁|由谁|找谁|向谁|哪个(?:人|部门)|是不是|是否|是何人|誰(?:が|に|ですか)|\b(?:who|whose|whether|quem|qual)\b)[^。！？\n]*[?？]$/i.test(text)
    || /^(?:请|麻烦|帮我)?(?:查询|查一下|查看|搜索|检索|告诉我|复述|提醒我)[^。！？\n]*(?:负责人|联系人|接收人|签字人|情况|已有|之前)/.test(text)
    || /(?:喜欢什么|偏好是什么)/.test(text);
}
function isInitialOneOffRequest(text: string): boolean {
  return ONE_OFF_REQUEST_PATTERN.test(text)
    || /\b(?:please|can you|could you|help me)\b.{0,80}\bprepare\b/i.test(text);
}
function futureRequirementIsExplicit(text: string): boolean {
  const future = text.match(SCREEN_EXPLICIT_FUTURE_PATTERN), requirement = text.match(SCREEN_REQUIREMENT_PATTERN);
  if (!future || !requirement) return false;
  // "cover future maintenance costs" describes the current requested output,
  // whereas "future reports need X" declares how later work should proceed.
  const recurring = /(?:经常|反复|复用|重复(?:使用|调用)|长期(?:保留|保存|记住|使用|采用|遵循)|毎回|再利用|\b(?:reus(?:e|able)|repeat(?:ed|able)? use|every time|keep .{0,24}long[- ]term)\b)/i.test(text);
  if ((future.index ?? 0) > (requirement.index ?? 0) && !recurring
    && /^(?:后续|未来|future|no futuro)$/i.test(future[0])) return false;
  return !isInitialOneOffRequest(text)
    || /^(?:以后|今后|后续|未来|从(?:今天|现在)起|每次|今後|これから|from now on|in future|every time)/i.test(text)
    || recurring;
}

// Keep concrete user assertions and their stated future role together inside
// one message. This is a model shortlist, never proof of the fact or authority
// to save it; it intentionally imposes no "must be permanent" type boundary.
const SCREEN_FACT_SUBJECT_PATTERN = /(?:项目|团队|服务|系统|环境|工具链|仓库|组织|部门|负责人|联系人|プロジェクト|チーム|サービス|システム|担当者|\b(?:project|team|service|system|environment|repository|organization|department|projeto|equipe|serviço|sistema)\b)/i;
const SCREEN_ASSERTED_RELATION_PATTERN = /(?:(?:负责人|联系人|审批人|接收人|签字人|责任人|版本|接口|入口|地址)(?:是|为|由|改为|变更为|换成)(?!谁|哪|什么|啥)[^。！？\n]{1,80}|由[^。！？\n]{1,32}(?:负责|审核|签字|审批)|[^。！？\n]{1,24}负责[^。！？\n]{1,60}|\b(?:owner|lead|approver|reviewer|recipient|contact|signatory|version|endpoint)\b[^.!?\n]{0,60}\b(?:is|are|became|changed to)\s+(?!who\b|what\b|which\b)\S|\b(?:is|are)\s+(?:the\s+)?(?:owner|lead|responsible for)\b|(?:担当者|責任者|連絡先|承認者|受信者|バージョン)(?:は|が)[^。！？\n]{1,80}(?:です|である|になった|に変更)|\b(?:responsável|contato|aprovador|destinatário|versão|proprietário)\b[^.!?\n]{0,60}(?:é|são|passou a ser|mudou para)\s+\S)/i;
const SCREEN_FUTURE_FACT_USE_PATTERN = /(?:准备|对接|验收材料|确认签字|签字|办理|审批|据此|以此|参照|联系|安排|使用|采用|核对|依据|担当者.{0,20}確認|確認|参照|使用|\b(?:prepare|contact|sign|signoff|sign-off|confirm|refer|use|follow|consult|preparar|contatar|confirmar|consultar|usar|utilizar|assinatura)\b)/i;
function userFactWithFutureUse(fragments: readonly string[]): string[] {
  const substantive = fragments.filter(fragment => !isScreeningQuery(fragment) && !SCREEN_TEMPORARY_PATTERN.test(fragment)
    && !isInitialOneOffRequest(fragment) && !isTrivialUserText(fragment) && !/[?？]|(?:吗|ですか)$/.test(fragment));
  const assertion = substantive.find(fragment => SCREEN_FACT_SUBJECT_PATTERN.test(fragment) && SCREEN_ASSERTED_RELATION_PATTERN.test(fragment));
  const futureUse = substantive.find(fragment => SCREEN_EXPLICIT_FUTURE_PATTERN.test(fragment) && SCREEN_FUTURE_FACT_USE_PATTERN.test(fragment)
    && meaningfulLength(fragment.replace(SCREEN_EXPLICIT_FUTURE_PATTERN, '')) >= 6);
  return assertion && futureUse ? [assertion, futureUse] : [];
}

function fragmentHasCaptureEvidence(fragment: string): boolean {
  // Queries can quote a durable rule without asserting or correcting it.
  if (isScreeningQuery(fragment)
    || /^(?:你(?:还)?(?:记得|记住|知道)|我是否|我是不是)/.test(fragment)
    || /(?:喜欢什么|偏好是什么)/.test(fragment)) return false;
  if (isTrivialUserText(fragment) || /^(?:默认|以后|今后|请记住|记住|from now on|remember)[\s，,:：]*(?:请|要)?$/i.test(fragment)) return false;
  let text = fragment;
  if (SCREEN_TEMPORARY_PATTERN.test(text)) {
    // A separate future clause may coexist with a one-off request. Restrict
    // checking to that clause rather than widening the temporary instruction.
    const futureClause = text.match(/[,，](?:\s*)(以后|今后|从(?:今天|现在)起|每次|长期|from now on|in future|every time).*/i);
    if (!futureClause) return false;
    text = futureClause[0].replace(/^[,，]\s*/, '');
  }
  if (STABLE_PERSONAL_FACT_PATTERN.test(text) && !/[?？]|吗$|么$/.test(text)) return true;
  if (SCREEN_CORRECTION_PATTERN.test(text) && SCREEN_REQUIREMENT_PATTERN.test(text)) return true;
  if (STABLE_PREFERENCE_PATTERN.test(text) && meaningfulLength(text.replace(STABLE_PREFERENCE_PATTERN, '')) > 0) return true;
  // A user can declare a recurring template without an imperative verb:
  // "the template I use for future weekly reviews" is not a one-off request.
  if (SCREEN_EXPLICIT_FUTURE_PATTERN.test(text) && TEMPLATE_PATTERN.test(text)
    && /(?:我(?:们)?.{0,48}(?:都用|使用|采用)|\bi (?:will )?use\b|私.{0,32}(?:使う|使用)|\b(?:eu uso|eu utilizo)\b)/i.test(text)
    && !isInitialOneOffRequest(text)) return true;
  if (futureRequirementIsExplicit(text)) return true;
  if (/(?:所有|每(?:次|个)|任何|\b(?:every|always|any)\b)/i.test(text)
    && /(?:必须|务必|不要|禁止|一律|都要|\b(?:must|never|required|always)\b)/i.test(text)) return true;
  if (/(?:记住|記憶して|覚えて|\bremember\b|\blembre\b)/i.test(text)
    && (SCREEN_REQUIREMENT_PATTERN.test(text.replace(/(?:记住|記憶して|覚えて|\bremember\b|\blembre\b)/ig, ''))
      || STABLE_PERSONAL_FACT_PATTERN.test(text))) return true;

  // User-stated methods and practice feedback need a condition/object plus
  // concrete actions or adoption. A long requested output is not evidence.
  if (isInitialOneOffRequest(text)) return false;
  if (SCREEN_METHOD_CONDITION_PATTERN.test(text) && SCREEN_METHOD_SEQUENCE_PATTERN.test(text)) return true;
  if (/(?:失败.{1,80}成功|failed.{3,100}(?:worked|succeeded))/i.test(text)
    && /(?:运行器|环境|工具|脚本|参数|\b(?:runner|environment|tool|script|parameter)\b)/i.test(text)
    && /(?:去掉|改成|移除|改用|\b(?:remove|without|changed)\b)/i.test(text)) return true;
  return SCREEN_PRACTICE_PATTERN.test(text)
    && SCREEN_FEEDBACK_ADOPTION_PATTERN.test(text)
    && (METHOD_PATTERN.test(text) || TEMPLATE_PATTERN.test(text) || SCREEN_METHOD_SEQUENCE_PATTERN.test(text));
}

/** A user may select source norms for examination without adopting them as
 * facts. Require that selection plus concrete recurring/normative material;
 * a save request or an attachment alone is insufficient. */
function selectedNormativeFragments(fragments: readonly string[]): string[] {
  const selection = fragments.find(fragment =>
    /(?:请|希望|帮我|需要).{0,48}(?:整理|导入|收录|保存).{0,24}(?:认知|资产|知识)/i.test(fragment)
    && !/(?:不要|不用|不必).{0,8}(?:整理|导入|收录|保存)/.test(fragment)
    && !SCREEN_QUERY_PATTERN.test(fragment));
  if (!selection) return [];
  return fragments.filter(fragment =>
    !SCREEN_TEMPORARY_PATTERN.test(fragment)
    && !SCREEN_QUERY_PATTERN.test(fragment)
    && /(?:规范|规则|标准|每(?:周|月|年|天|日|次)|\b(?:policy|standard|weekly|monthly|annually|daily|every)\b)/i.test(fragment)
    && /(?:(?:使用|采用|提交|交给|审核|必须|禁止|不得).{1,64}|\b(?:use|submit|review|must|never)\b.{3,64})/i.test(fragment));
}

export function screenRecallCaptureValue(
  messages: readonly RecallCaptureScreeningMessage[],
): RecallCaptureValueScreeningResult {
  const userMessages = messages.filter(message => message.role === 'user');
  if (!userMessages.length) return { eligible: false, signals: [], reason: 'low_reuse_value' };
  const nonTrivialUsers = userMessages.filter(message => !isTrivialUserText(message.text));
  if (!nonTrivialUsers.length) return { eligible: false, signals: [], reason: 'trivial_exchange' };

  const evidence = nonTrivialUsers.flatMap(message => {
    const fragments = screeningUserFragments(message.text);
    return [...fragments.filter(fragmentHasCaptureEvidence), ...selectedNormativeFragments(fragments), ...userFactWithFutureUse(fragments)];
  });
  if (evidence.length) {
    const signals = collectSignals(evidence.map(text => ({ role: 'user', text })));
    if (messages.some(message => (message.artifacts?.length || 0) > 0)) pushUnique(signals, 'artifact');
    if (!signals.length) signals.push('substantive_exchange');
    return { eligible: true, signals };
  }

  // One-off requests and unanswered identity questions are not durable statements.
  // An attached result can still be judged later; assistant keywords never are.
  const fragments = nonTrivialUsers.flatMap(message => screeningUserFragments(message.text));
  const ordinaryRequest = /^(?:解释一下这个方法|帮我生成这次活动的清单|这次报告用表格|继续|现在进展如何|谢谢|分析一下这份文件|这段代码为什么报错|今天吃什么)$/;
  const identityQuestion = (fragment: string) => /[?？]/.test(fragment) && /(?:我的(?:名字|姓名|职业|部门|母语)|你记得我)/.test(fragment);
  const hasArtifact = messages.some(message => (message.artifacts?.length || 0) > 0);
  if (fragments.length && fragments.every(fragment => ordinaryRequest.test(normalized(fragment)))) {
    return { eligible: false, signals: [], reason: 'low_reuse_value' };
  }
  if (!hasArtifact && fragments.length && fragments.every(identityQuestion)) {
    return { eligible: false, signals: [], reason: 'low_reuse_value' };
  }
  return { eligible: true, signals: ['substantive_exchange'] };
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
  const conflicting = (boundaries.conflictingTypes || []).filter((type) => type && type !== 'cognition' && candidate.suggestedType !== 'cognition' && type !== candidate.suggestedType);
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

  if (candidate.suggestedType === 'fact') {
    // fact 只收稳定的项目/环境/领域/工具链事实。带“今天/本次/当前”等
    // 时间壳且没有长期标记的叙述是任务状态，不是可复用事实。
    if (PROJECT_FACT_PATTERN.test(text) && !LONG_TERM_PATTERN.test(text) && !STABLE_FACT_CHANGE_PATTERN.test(text)) {
      pushUnique(blockingReasons, 'fact_not_stable');
    } else if (!LONG_TERM_PATTERN.test(text) && !STABLE_FACT_SUBJECT_PATTERN.test(text)) {
      pushUnique(advisoryReasons, 'fact_not_stable');
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
    // PRD 3.1 要求 RuleAsset 确认适用与禁止范围。自动线（capture 模型常只给
    // 一边、KStar 聚合只声明有证据支撑的适用边界）拿不到双向边界是常态——
    // 适用或禁止任一存在即算有边界，缺的一边由用户复核时补（Q1 决策）。
    // 注意：收紧为「两者都必须存在」（&&）会让 KStar 沉淀的 rule（只带
    // applicableWhen）全部被系统线阻断——实机 26 个 rule 资产均为单边界，
    // 证明单边界是既有设计，不是疏漏。
    const hasBoundary = (boundaries.applicableWhen?.length || 0) > 0
      || (boundaries.forbiddenWhen?.length || 0) > 0;
    if (!hasBoundary) pushUnique(advisoryReasons, 'rule_missing_boundary');
  }

  // P2 内容瘦身（2026-09-13）：statement 软预算。statement = judgment + value
  // 拼接（candidate-service 晋升时），长叙事应留在 evidence——statement 只写
  // 「结论 + 该怎么做」。超 300 字只记 advisory 不阻断：存量 300-800 字合法
  // 存在，且现有硬上限是 4000（boundedText），300 只能作提示不能作闸门。
  const statementLength = candidate.judgment.length + String(candidate.value || '').length;
  if (statementLength > 300) pushUnique(advisoryReasons, 'statement_over_soft_budget');

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

  // A pure operation receipt is not a learned understanding, even when its
  // title/value add template or method words. Bounded explanations and lessons
  // remain eligible for the semantic value stage rather than this narrow gate.
  const explainsInsight = /(?:因为|因此|说明|发现|导致|由此|否则|条件|仅在|\b(?:because|therefore|shows? that|found that|caused|only if)\b)/i.test(candidate.judgment);
  if (!explainsInsight && (/^(?:(?:本次|这次|今天|刚才)[，,:： ]*)?(?:已(?:经)?|成功|顺利)(?:使用[^。！？\n]{0,40})?(?:完成|生成|保存|导出|执行|调用|处理|安装)[^。！？\n]*[。.!！]?$/i.test(candidate.judgment.trim())
    || /^(?:successfully\s+)?(?:completed|generated|saved|exported|executed|installed)\b[^.!?\n]*[.!]?$/i.test(candidate.judgment.trim()))) {
    reasons.push('operation_report_without_insight');
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

/** 一次任务的操作限制不能自动变成长期规则；不按验收/调试等主题词过滤。 */
export function isTaskLocalRuleProposal(
  candidate: RecallCaptureCandidateQualityInput,
  messages: readonly RecallCaptureScreeningMessage[],
): boolean {
  if ((candidate.suggestedType !== 'rule' && candidate.suggestedType !== 'cognition') || (candidate.suggestedAction && candidate.suggestedAction !== 'create')) return false;
  const users = messages.filter(message => message.role === 'user');
  if (!users.length) return false;
  const localBoundary = /(?:本次|这次|当前(?:回合|任务|对话)|この(?:タスク|会話)|今回|\b(?:this (?:task|turn|conversation)|for this run|nesta (?:tarefa|conversa))\b).{0,80}(?:只|仅|不要|禁止|不(?:得|允许|使用|执行)|だけ|のみ|禁止|\b(?:only|do not|must not|apenas|somente|não))|仅限(?:本次|这次)/i;
  return users.some(message => localBoundary.test(message.text))
    && users.every(message => !FUTURE_OR_REUSE_INTENT_PATTERN.test(message.text) && !STABLE_PREFERENCE_PATTERN.test(message.text));
}

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
  | 'candidate_not_reusable';

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

  const uniqueReasons = [...new Set(reasons)];
  const automaticIneligibilityReasons = assessAutomaticEligibility(candidate, evidenceMessages, uniqueReasons);
  return {
    reviewable: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    automaticEligible: automaticIneligibilityReasons.length === 0,
    automaticIneligibilityReasons,
  };
}

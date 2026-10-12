/**
 * Decide whether a cross-session memory tool call is authorized by the
 * current user's message. Intent is deliberately conservative: only a clear
 * save instruction or a standalone confirmation may create a candidate.
 */

export type MemorySaveIntent = 'none' | 'review' | 'direct';
export type MemoryEditIntent = 'none' | 'direct';

interface SaveVerbMatch {
  index: number;
  length: number;
  negated: boolean;
  explicit: boolean;
}

const SAVE_VERB = /记住|記住|记下|記下|记一下|記一下|保存|存下|记录|記錄|覚えておかないで|覚えないで|記憶しないで|保存しないで|記録しないで|覚えておいてください|覚えておいて|覚えてください|覚えて|記憶しておいて|記憶してください|記憶して|保存してください|保存しておいて|保存して|記録してください|記録しておいて|記録して|lembre-se|lembre|memorize|memorise|guarde|salve|registre|mantenha\s+em\s+mente|\b(?:remember|save|store|keep\s+in\s+mind)\b/giu;
const EDIT_VERB = /改成|改为|更正|纠正|修改|更新|替换|调整|编辑|変えないで|変更しないで|修正しないで|書き換えないで|変えて|変更して|修正して|書き換えて|更新して|置き換えて|訂正して|altere|mude|atualize|substitua|corrija|edite|modifique|\b(?:change|update|replace|correct|edit|revise)\b/giu;
const REMOVE_VERB = /忘记|忘掉|遗忘|删除|移除|清除|删掉|忘れないで|削除しないで|消さないで|忘れてください|忘れて|削除してください|削除して|消してください|消して|取り消して|esqueça|esqueca|remova|exclua|apague|elimine|\b(?:forget|remove|delete|erase)\b/giu;
const CLAUSE_BREAK = /[。！？.!?；;，,：:\n]/g;

function normalized(value: unknown): string {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function clausePrefix(text: string, index: number): string {
  let start = 0;
  for (const match of text.slice(0, index).matchAll(CLAUSE_BREAK)) {
    start = (match.index || 0) + match[0].length;
  }
  return text.slice(start, index).trim();
}

function isNegated(prefix: string, suffix = '', command = ''): boolean {
  const chineseNegation = /(?:不要|别|別|不想(?:再)?(?:让你|讓你)?|不需要|不必|不用|无需|無需|不应|不應|不能|禁止|切勿|请勿|請勿|拒绝|拒絕|勿|没|沒有|未)[^，。；,.;:!?！？：]{0,24}$/i;
  const englishNegation = /\b(?:do not|did not|don't|doesn't|didn't|dont|never|not|avoid|won't|can't|shouldn't)\b[^，。；,.;:!?！？：]{0,32}$/i;
  const portugueseNegation = /\b(?:n[aã]o|nunca|jamais|evite)\b[^，。；,.;:!?！？：]{0,32}$/i;
  const japaneseNegativeCommand = /(?:ないで|ません|ない)$/.test(command);
  const japaneseNegativeSuffix = /^(?:ないで|なくて|ません|ない|ほしくない|ほしくありません|はいけません)/.test(suffix);
  return chineseNegation.test(prefix)
    || englishNegation.test(prefix)
    || portugueseNegation.test(prefix)
    || japaneseNegativeCommand
    || japaneseNegativeSuffix;
}

function hasExplicitDirectiveLead(prefix: string, isAtMessageStart: boolean): boolean {
  if (!prefix) return isAtMessageStart;
  return /^(?:please|kindly|can you|could you|would you|i want you to|i'd like you to|por favor|por gentileza|por obs[eé]quio)$/i.test(prefix)
    || /^(?:请(?:你)?(?:帮我)?|麻烦(?:你)?|帮我|我希望你|我想让你|我要你|以后(?:请)?|从现在起(?:请)?|どうか)$/.test(prefix)
    || /^(?:これ|それ|この(?:内容|こと|設定|好み|記憶|ルール)|その(?:内容|こと|設定|好み|記憶|ルール))(?:を|は)$/.test(prefix);
}

function isStandaloneConfirmation(text: string): boolean {
  return /^(?:yes|yeah|yep|sure|go ahead|please do|do it|okay|ok|sounds good|sim|claro|pode ser|confirmo|está bem|esta bem|はい|お願いします|そうしてください|その通り|是|是的|好|好的|可以|行|没问题|就这样|照这个|按这个|确认)[.!！。]*$/i.test(text);
}

function hasExplicitEditLead(prefix: string, isAtMessageStart: boolean): boolean {
  if (!prefix) return isAtMessageStart;
  if (/^(?:please|kindly|can you|could you|would you|i want you to|i'd like you to|por favor|por gentileza|por obs[eé]quio)(?: please)?$/i.test(prefix)) return true;
  if (hasExplicitDirectiveLead(prefix, false)) return true;
  if (/^(?:これ|それ|この(?:内容|こと|設定|好み|記憶|ルール)|その(?:内容|こと|設定|好み|記憶|ルール))(?:を|は)(?:次のように|以下のように)?$/.test(prefix)) return true;
  // Chinese 把/将字句 places the requested target before the edit verb:
  // "请把我的偏好改成…". Accept only a short imperative lead, not a report
  // such as "我已经把偏好改成…".
  return /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我|我希望你|我想让你|我要你|我想)?(?:把|将)[^，。；,.;:!?！？：]{0,40}$/.test(prefix)
    || /^(?:请|麻烦|帮我|我希望你|我想让你|我要你)[^，。；,.;:!?！？：]{0,40}$/.test(prefix);
}

function hasCommaSeparatedDirectiveLead(text: string, index: number): boolean {
  return /^(?:please|kindly|por favor|por gentileza|por obs[eé]quio|お願いします|どうか|请(?:你)?(?:帮我)?|麻烦(?:你)?|帮我)\s*,\s*$/i.test(text.slice(0, index));
}

function commandMatches(text: string, pattern: RegExp, kind: 'edit' | 'remove'): SaveVerbMatch[] {
  return Array.from(text.matchAll(pattern), (match) => {
    const index = match.index || 0;
    const prefix = clausePrefix(text, index);
    const isAtMessageStart = index === prefix.length;
    return {
      index,
      length: match[0].length,
      negated: isNegated(
        text.slice(Math.max(0, index - 60), index),
        text.slice(index + match[0].length, index + match[0].length + 20),
        match[0],
      ),
      explicit: kind === 'edit'
        ? hasExplicitEditLead(prefix, isAtMessageStart) || hasCommaSeparatedDirectiveLead(text, index)
        : hasExplicitDirectiveLead(prefix, isAtMessageStart) || hasCommaSeparatedDirectiveLead(text, index),
    };
  });
}

function hasOneExplicitCommand(matches: SaveVerbMatch[]): SaveVerbMatch | undefined {
  const positive = matches.filter((match) => match.explicit && !match.negated);
  if (positive.length !== 1 || matches.some((match) => match.negated)) return undefined;
  return positive[0];
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[。.!?！？]+$/g, '').trim();
}

function findSaveVerbs(text: string): SaveVerbMatch[] {
  return Array.from(text.matchAll(SAVE_VERB), (match) => {
    const index = match.index || 0;
    const prefix = clausePrefix(text, index);
    const isAtMessageStart = index === prefix.length;
    return {
      index,
      length: match[0].length,
      negated: isNegated(
        text.slice(Math.max(0, index - 60), index),
        text.slice(index + match[0].length, index + match[0].length + 20),
        match[0],
      ),
      explicit: hasExplicitDirectiveLead(prefix, isAtMessageStart)
        || hasCommaSeparatedDirectiveLead(text, index),
    };
  });
}

/**
 * `direct` means exact user wording followed an explicit save command in the
 * same message. `review` means the user authorized a save but the proposed
 * wording needs review, or the user confirmed a specific proposal. `none`
 * means the message does not authorize creating a cross-session candidate.
 */
export function classifyMemorySaveIntent(
  userMessage: unknown,
  proposedText: unknown,
  sourceMessageFromUser: boolean,
): MemorySaveIntent {
  if (sourceMessageFromUser !== true) return 'none';
  const source = normalized(userMessage);
  if (!source) return 'none';

  const matches = findSaveVerbs(source);
  const positiveDirectives = matches.filter((match) => match.explicit && !match.negated);
  if (positiveDirectives.length === 0) {
    // Conflicting localized save instructions may not have a recognizable
    // imperative lead on both clauses. They can only create a review item;
    // they never gain the direct activation path.
    if (matches.some((match) => match.negated) && matches.some((match) => !match.negated)) return 'review';
    return isStandaloneConfirmation(source) ? 'review' : 'none';
  }

  // Ambiguous or mixed instructions never auto-activate; they can still be
  // presented for user review because a positive directive was explicit.
  if (positiveDirectives.length !== 1 || matches.some((match) => match.negated)) return 'review';

  const command = positiveDirectives[0];
  const proposed = normalized(proposedText);
  if (!proposed) return 'review';
  const proposedStart = source.indexOf(proposed, command.index + command.length);
  if (proposedStart < command.index + command.length) return 'review';

  const remainder = source.slice(command.index + command.length).replace(/^[\s:：—–-]+/, '');
  if (stripTerminalPunctuation(remainder) !== stripTerminalPunctuation(proposed)) return 'review';
  return 'direct';
}

/**
 * Direct replacement is allowed only for one explicit user edit command whose
 * replacement wording is copied from the current user message. Paraphrased
 * edits have no direct-write path; callers must leave the asset untouched.
 */
export function classifyMemoryReplaceIntent(
  userMessage: unknown,
  proposedText: unknown,
  sourceMessageFromUser: boolean,
): MemoryEditIntent {
  if (sourceMessageFromUser !== true) return 'none';
  const source = normalized(userMessage);
  if (!source) return 'none';
  const command = hasOneExplicitCommand(commandMatches(source, EDIT_VERB, 'edit'));
  if (!command) return 'none';

  const proposed = normalized(proposedText);
  if (!proposed) return 'none';
  const proposedStart = source.indexOf(proposed, command.index + command.length);
  if (proposedStart < command.index + command.length) return 'none';
  const bridge = source.slice(command.index + command.length, proposedStart);
  const after = source.slice(proposedStart + proposed.length);
  if (bridge.length > 80 || /[。.!?！？；;,，]/.test(bridge)) return 'none';
  if (!/^[\s」』"'）)】]*[。.!?！？]*\s*$/.test(after)) return 'none';
  return 'direct';
}

/** A forget/remove tool call must be authorized by a current user command. */
export function classifyMemoryRemoveIntent(
  userMessage: unknown,
  sourceMessageFromUser: boolean,
): MemoryEditIntent {
  if (sourceMessageFromUser !== true) return 'none';
  const source = normalized(userMessage);
  if (!source) return 'none';
  return hasOneExplicitCommand(commandMatches(source, REMOVE_VERB, 'remove')) ? 'direct' : 'none';
}

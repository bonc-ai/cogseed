// These commands are parsed from the current user's visible text, before any
// space context, references, or model output is added to the turn.
const chineseMove = /^(?:请(?:帮我|你|先|根据(?:聊天|对话)内容识别[^，,]{1,80}[，,]\s*并)?|帮我|麻烦你)?\s*(?:自动)?\s*(?:把|将)\s*(?:当前(?:的)?|这个|这条|本|该)?\s*(?:会话|对话|聊天|任务)\s*(?:切换|切|移动|移|转移|转)\s*(?:到|至)\s*(?:(?:已有|现有|已经存在)的?\s*)?(.+)$/u;
const englishMove = /^(?:please\s+)?(?:move|switch|transfer)\s+(?:this|the current)\s+(?:chat|conversation|session)\s+(?:to|into)\s+(?:the\s+)?(?:existing\s+)?(.+)$/iu;
const quoteEnd: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'", '\x60': '\x60' };

function unquotedSentences(text: string): string[] {
  const sentences: string[] = [];
  const quotes: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === quotes[quotes.length - 1]) {
      quotes.pop();
    } else if (quoteEnd[char] && (char !== "'" || !/[A-Za-z0-9]/u.test(text[i - 1] || ''))) {
      quotes.push(quoteEnd[char]);
    } else if (quotes.length === 0 && (/[\n。！？；!?;]/u.test(char)
      || (char === '.' && /\s|^$/u.test(text[i + 1] || '')))) {
      if (char !== '？' && char !== '?') sentences.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quotes.length === 0) sentences.push(text.slice(start));
  return sentences;
}

export function requestedConversationSpaceNames(text: string): string[] | undefined {
  // Quoted transcripts and examples cannot give a chat command authority.
  if (text.includes('```') || /^\s*>/m.test(text)) return undefined;
  const sentences = unquotedSentences(text).map(clause => clause.trim());
  if (sentences.some(clause => {
    const afterNegation = clause.replace(/^(?:请\s*)?(?:不要|别|无需|不用|暂不|do not\b|don't\b)\s*/iu, '');
    return afterNegation !== clause && (chineseMove.test(afterNegation) || englishMove.test(afterNegation)
      || /^(?:切换|切|移动|转移)(?:工作空间|工作区|空间|了)?$/u.test(afterNegation));
  })) return undefined;
  const commands = sentences
    .map(clause => chineseMove.exec(clause)?.[1] || englishMove.exec(clause)?.[1])
    .filter((target): target is string => !!target);
  if (commands.length !== 1) return undefined;

  const target = commands[0].trim();
  const quoted = /^(?:「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"|'([^']+)'|‘([^’]+)’|\x60([^\x60]+)\x60)\s*(?:工作空间|工作区|空间|workspace|space)?$/iu.exec(target);
  if (quoted) {
    const name = quoted.slice(1).find(Boolean)?.trim();
    return name ? [name] : undefined;
  }
  // A bare name can include the word "workspace"; check both readings and
  // require a unique saved identity before committing either one.
  if (/[，,：:？?「」『』“”"'<>]/u.test(target)) return undefined;
  const name = target.replace(/\s*(?:工作空间|工作区|空间)$|\s+(?:workspace|space)$/iu, '').trim();
  return [...new Set([target, name].filter(Boolean))];
}

export type ConversationSpaceChange =
  | { status: 'moved' | 'already_there'; name: string }
  | { status: 'not_found' | 'ambiguous' | 'changed' | 'cancelled' };

export async function moveCurrentConversationToExistingSpace(
  userId: string,
  cid: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<ConversationSpaceChange> {
  if (signal?.aborted) return { status: 'cancelled' };
  const { getConversation, setConversationSpace } = await import('../chats');
  const conversation = await getConversation(userId, cid);
  if (!conversation || conversation.kind === 'space_builder' || conversation.a2a || conversation.channel_platform) {
    return { status: 'changed' };
  }
  const { findExistingSpacesByName } = await import('../spaces');
  const matches = await findExistingSpacesByName(userId, names);
  if (matches.length !== 1) {
    return { status: matches.length ? 'ambiguous' : 'not_found' };
  }
  const space = matches[0];
  const changed = await setConversationSpace(userId, cid, space.space_id, conversation.project_id ?? null, {
    expectedSpaceId: conversation.space_id ?? null,
    signal,
  });
  if (!changed) return { status: signal?.aborted ? 'cancelled' : 'changed' };
  return { status: conversation.space_id === space.space_id ? 'already_there' : 'moved', name: space.name };
}

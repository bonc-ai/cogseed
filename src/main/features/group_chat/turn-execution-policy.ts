import { maxToolLoopsForActorTurn } from './actor-budgets';
import type { ActorKind } from './state';
import type { GroupMessageMetrics } from './visibility';

/** Narrow instruction grammar for the current user turn only. This can remove
 * capabilities or lower budgets, never grant permissions. Quotes, examples and
 * code are data; unrecognized wording keeps the normal execution policy. */
export function resolveTurnExecutionPolicy(kind: ActorKind, userText: string | undefined): {
  maxToolLoops?: number;
  maxToolCalls?: number;
  toolDenylist?: readonly string[];
  suppressExecutionPlanInstructions?: boolean;
} {
  const source = String(userText || '')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n<quoted>\n')
    // Apostrophes inside words (don't) are not quotation delimiters.
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|`[^`\n]*`/gu, '<quoted>');
  const instructionLines: string[] = [];
  let exampleBlock = false;
  for (const line of source.split('\n')) {
    if (!line.trim()) { exampleBlock = false; continue; }
    if (/^\s*>/u.test(line) || exampleBlock) continue;
    // Keep explanatory/negated headings attached to their examples instead of
    // treating text following the colon as a new authoritative instruction.
    const dataScope = line.search(/(?:示例|例如|举例|例子|examples?|for example)\s*[：:]|^\s*(?:(?:请|帮我)?(?:解释|翻译|讨论)[^。.;；\n:：]*[：:]|(?:please\s+)?(?:explain|translate|discuss)\b[^.;\n:]*:|(?:不要|不用|无需)(?:(?:遵守|执行|采用|应用)(?:以下|这些|上述|下列)?(?:限制|规则|策略|指令)|限制为)\s*[：:])/iu);
    if (dataScope >= 0) {
      instructionLines.push(line.slice(0, dataScope));
      exampleBlock = true;
    } else instructionLines.push(line);
  }
  const clauses = instructionLines.join('\n')
    .split(/[\n,，。.;；:：、!?！？]/u)
    .map(clause => clause.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, ''));
  let maxToolCalls: number | undefined;
  let light = false;
  let suppressPlan = false;
  for (const clause of clauses) {
    if (/^(?:请)?(?:仅修|只修|只改|仅改|定向修复)\S/u.test(clause) || /^only fix\s+\S/i.test(clause)) light = true;
    const cap = /^(?:请)?(?:目标)?(?:最多|不超过)\s*(\d{1,6})\s*次工具调用$/u.exec(clause)
      || /^(?:use\s+)?(?:at most|no more than)\s+(\d{1,6})\s+tool calls?$/i.exec(clause);
    if (cap) maxToolCalls = Math.min(maxToolCalls ?? Infinity, Number(cap[1]));
    if (/^(?:请)?(?:不用|不要使用|禁止使用|禁止|不使用)\s*(?:计划工具|manage_execution_plan)$/u.test(clause)
      || /^(?:do not use|don't use|never use)\s+manage_execution_plan$/i.test(clause)) suppressPlan = true;
  }
  const maxToolLoops = maxToolLoopsForActorTurn(kind, { taskClass: light ? 'light' : 'unknown' });
  return {
    ...(maxToolLoops === undefined ? {} : { maxToolLoops }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(suppressPlan ? { toolDenylist: ['manage_execution_plan'], suppressExecutionPlanInstructions: true } : {}),
  };
}

/** Persist only the known numerical phase fields; no coercion or raw payload. */
export function normalizeRunTimings(data: Record<string, unknown>): GroupMessageMetrics['timings'] {
  const timings: NonNullable<GroupMessageMetrics['timings']> = {};
  const fields = { provider_ms: 'providerMs', tool_ms: 'toolMs', compaction_ms: 'compactionMs', retry_wait_ms: 'retryWaitMs', other_ms: 'otherMs' } as const;
  for (const [source, target] of Object.entries(fields)) {
    const value = data[source];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) timings[target] = value;
  }
  return Object.keys(timings).length ? timings : undefined;
}

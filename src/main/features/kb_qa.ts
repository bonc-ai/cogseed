/**
 * KB grounded Q&A (知识库模块 S2，计划书 v1.3 §S2).
 *
 * One-call stream for "基于知识库提问": runs `askMaterials` (hybrid
 * retrieval + threshold), then either streams an LLM answer grounded
 * ONLY in the returned evidence (each claim carries a `path#chunk N`
 * citation anchor), or says plainly that the material set has nothing —
 * no fabrication, no web fallback (same protocol as ask_materials).
 *
 * Read-only pipeline: never writes to chats / conversation bus, mirrors the
 * aside pattern (`streamChatWithModel` injected via deps, so this module is
 * unit-testable without a live provider).
 */

import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import { askMaterials, formatEvidence } from '../model/core-agent/ask-materials';
import type { MaterialHit } from '../model/core-agent/material-search';

const log = createLogger('kb-qa');

export interface KbAskInput {
  /** 空 = 全局（用户个人资料库）；非空 = 空间库。 */
  spaceId?: string | null;
  question: string;
  k?: number;
}

export interface KbAskDeps {
  /** Injected model call — keeps this module testable without a live provider. */
  stream: (opts: {
    userId: string;
    message: string;
    systemPrompt: string;
    sessionId: string;
  }) => AsyncIterable<{ type: string; text?: string }>;
}

/** 渲染层引用 chip 需要的精简证据条目（与 `path#chunk N` 锚点一一对应）。 */
export interface KbEvidenceRef {
  source: MaterialHit['source'];
  scope: MaterialHit['scope'];
  path: string;
  chunkIdx: number;
  snippet: string;
  score: number;
}

export interface KbAskEvent {
  type: 'delta' | 'final' | 'error';
  text?: string;
  /** 证据包：final 时携带，渲染层据此绘制引用 chip（点击回跳原文）。 */
  evidence?: KbEvidenceRef[];
  noMaterial?: boolean;
  reason?: 'no_material' | 'low_confidence';
}

const KB_SYSTEM_PROMPT = `你是知识库问答助手。只依据提供的 ask_materials 证据回答；
每一条结论都必须标注引用 \`path#chunk N\`；资料中没有的内容明确说「资料中未找到」，
不要编造，不要切换联网搜索，除非用户明确要求。`;

function toEvidenceRefs(hits: MaterialHit[]): KbEvidenceRef[] {
  return hits.map((h) => ({
    source: h.source,
    scope: h.scope,
    path: h.path,
    chunkIdx: h.chunkIdx,
    snippet: h.snippet,
    score: h.score,
  }));
}

export async function* kbAskStream(
  userId: string,
  input: KbAskInput,
  deps: KbAskDeps,
): AsyncGenerator<KbAskEvent, void, unknown> {
  const question = String(input.question ?? '').trim();
  if (!question) {
    yield { type: 'error', text: 'empty question' };
    return;
  }

  let res;
  try {
    res = await askMaterials({
      userId,
      query: question,
      scope: input.spaceId ? 'space' : 'global',
      spaceId: input.spaceId || undefined,
      k: typeof input.k === 'number' && input.k > 0 ? input.k : undefined,
    });
  } catch (err) {
    log.warn('ask_materials failed', { user_id: maskId(userId), error: (err as Error).message });
    yield { type: 'error', text: (err as Error).message };
    return;
  }

  const evidence = toEvidenceRefs(res.hits);

  if (!res.hasEvidence) {
    const text = res.reason === 'no_material'
      ? '资料中未找到与问题相关的内容。可以补充资料后再问，或换个问法。'
      : '找到的相关资料很弱，无法给出可靠回答。建议换个问法或补充资料。';
    yield { type: 'final', text, noMaterial: true, reason: res.reason, evidence };
    return;
  }

  const systemPrompt = `${KB_SYSTEM_PROMPT}\n\n${formatEvidence(res)}`;
  let answer = '';
  try {
    for await (const event of deps.stream({
      userId,
      message: question,
      systemPrompt,
      sessionId: `aside-kbqa-${userId}`,
    })) {
      if (event.type === 'delta' && event.text) {
        answer += event.text;
        yield { type: 'delta', text: event.text };
      } else if (event.type === 'error') {
        yield { type: 'error', text: event.text || 'kb answer failed' };
        return;
      }
    }
  } catch (err) {
    log.warn('kb stream failed', { user_id: maskId(userId), error: (err as Error).message });
    yield { type: 'error', text: (err as Error).message };
    return;
  }

  if (!answer.trim()) {
    yield { type: 'error', text: 'empty answer' };
    return;
  }

  yield { type: 'final', text: answer, evidence };
}

export const _internals = { toEvidenceRefs };

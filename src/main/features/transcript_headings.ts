/**
 * transcript_headings — 主题标题生成（方案 v0.2 §五 P2-2）
 *
 * 方案要求：**只生成标题、不改正文、逐条人工确认**（对应 09-14 对照里的 15 个
 * 主题标题）。所以本模块只做"提议"：给出候选标题 + 它应该插在哪个发言块之前；
 * 插不插、插哪几条由用户点。真正的插入也走同一套编辑集（structure 标记），
 * 于是 offsetMap / diff / 回滚仍然一致。
 *
 * 与 LLM 候选同一范式：可注入 `runModel`、未配置模型时如实说明、输出严格校验
 * （标题必须是单行短文本，越界/多行/带标点堆砌一律丢弃）。
 */

import { createLogger } from '../logger';
import { buildRunner } from '../model/core-agent/runner';
import { hasConfiguredModel } from './auth';
import { parseTranscriptBlocks } from './transcript_speaker_merge';

const log = createLogger('transcript-headings');

/** 标题长度上限（按码点）。 */
export const HEADING_MAX_CHARS = 24;
/** 一次最多问多少段（段太多会让模型输出不准）。 */
export const HEADING_MAX_CHUNKS = 40;

export interface HeadingSuggestion {
  /** 该标题应插在这一段之前（段序号，从 0 开始）。 */
  chunkIndex: number;
  /** 原文偏移（插入点）。 */
  start: number;
  title: string;
}

export interface HeadingResult {
  headings: HeadingSuggestion[];
  skipped?: 'no_model' | 'too_short' | 'model_failed';
}

export const HEADING_SYSTEM_PROMPT = [
  '你是会议记录编辑。输入是一份逐字稿的若干段落（每段前面有序号与发言人）。',
  '请为每个有明确主题切换的段落拟一个小标题。',
  '规则：',
  '1. 只写小标题，5–14 个字，不要书名号/引号/句末标点；',
  '2. 没有主题切换的段落不要硬给标题（宁缺勿滥）；',
  '3. 不要改写、不要总结段落内容，只给标题；',
  '4. 只输出 JSON 数组：{"chunkIndex":段落序号,"title":"小标题"}；没有合适的就输出 []。',
].join('\n');

/**
 * 把逐字稿切成"待拟标题的段落"：优先按发言块（`parseTranscriptBlocks`），
 * 每 `chunkSize` 块合成一段；没有块头时按空行/长度切。
 * 返回的 `start` 是段落起点在原文里的偏移，用于插入标题。
 */
export function splitForHeadings(
  text: string,
  opts: { chunkSize?: number; maxChunks?: number } = {},
): Array<{ index: number; start: number; speakers: string[]; preview: string }> {
  const chunkSize = Math.max(1, opts.chunkSize ?? 8);
  const maxChunks = Math.max(1, opts.maxChunks ?? HEADING_MAX_CHUNKS);
  const blocks = parseTranscriptBlocks(text);
  const chunks: Array<{ index: number; start: number; speakers: string[]; preview: string }> = [];
  if (blocks.length === 0) {
    // 没有块头：按空行切段，仍然给出可插入的偏移
    let cursor = 0;
    const chunksRaw: Array<{ start: number; body: string }> = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        if (chunksRaw.length && chunksRaw[chunksRaw.length - 1].body === '') chunksRaw.pop();
        chunksRaw.push({ start: cursor + line.length + 1, body: '' });
      } else {
        const last = chunksRaw[chunksRaw.length - 1];
        if (last) last.body += last.body ? `\n${line}` : line;
        else chunksRaw.push({ start: cursor, body: line });
      }
      cursor += line.length + 1;
    }
    return chunksRaw.slice(0, maxChunks).map((chunk, index) => ({
      index,
      start: chunk.start,
      speakers: [],
      preview: chunk.body.slice(0, 120),
    }));
  }
  for (let i = 0; i < blocks.length; i += chunkSize) {
    const group = blocks.slice(i, i + chunkSize);
    chunks.push({
      index: chunks.length,
      start: group[0].headerStart,
      speakers: [...new Set(group.map((block) => block.speaker))],
      preview: group
        .map((block) => text.slice(block.bodyStart, Math.min(block.bodyEnd, block.bodyStart + 120)).trim())
        .join(' ')
        .slice(0, 300),
    });
    if (chunks.length >= maxChunks) break;
  }
  return chunks;
}

/** 构造请求（纯函数）。 */
export function buildHeadingRequest(
  chunks: Array<{ index: number; speakers: string[]; preview: string }>,
): { systemPrompt: string; message: string } {
  return {
    systemPrompt: HEADING_SYSTEM_PROMPT,
    message: chunks
      .map((chunk) => `【${chunk.index}】${chunk.speakers.length ? `（${chunk.speakers.join('、')}）` : ''}${chunk.preview}`)
      .join('\n\n'),
  };
}

/** 清洗标题：单行、去引号/尾标点、限长；不合格返回空串。 */
export function sanitizeHeading(raw: string): string {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^[#\s]+/, '').replace(/^["'“”‘’「」《【]+/, '').replace(/["'“”‘’「」《】]+$/, '');
  text = text.replace(/[。.!！?？,，;；:：]+$/, '').trim();
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length > HEADING_MAX_CHARS) return '';
  // 纯标点/纯数字不算标题
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  return text;
}

/** 解析模型输出（纯函数）：越界段落、空标题、超长标题一律丢弃。 */
export function parseHeadingResponse(
  raw: string,
  chunks: Array<{ index: number; start: number }>,
): HeadingSuggestion[] {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]));
  const out = new Map<number, HeadingSuggestion>();
  for (const item of parsed) {
    const row = item as Partial<{ chunkIndex: unknown; title: unknown }>;
    const index = Number(row?.chunkIndex);
    const chunk = byIndex.get(index);
    if (!chunk) continue;
    const title = sanitizeHeading(String(row?.title ?? ''));
    if (!title) continue;
    out.set(index, { chunkIndex: index, start: chunk.start, title });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

export interface SuggestOptions {
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
  chunkSize?: number;
  sessionKey?: string;
}

/** 一次性小调用：给出候选标题（不改任何东西）。 */
export async function suggestHeadings(
  userId: string,
  text: string,
  options: SuggestOptions = {},
): Promise<HeadingResult> {
  const chunks = splitForHeadings(text, { chunkSize: options.chunkSize });
  if (chunks.length === 0 || text.trim().length < 200) return { headings: [], skipped: 'too_short' };
  const request = buildHeadingRequest(chunks);
  if (!options.runModel && !hasConfiguredModel().configured) {
    return { headings: [], skipped: 'no_model' };
  }
  let raw = '';
  try {
    if (options.runModel) {
      raw = await options.runModel(request);
    } else {
      const { runner } = await buildRunner({
        sessionId: `transcript-headings-${options.sessionKey ?? userId}`,
        userId,
        systemPrompt: request.systemPrompt,
        disableTools: true,
        ephemeralSession: true,
        skillList: [],
      });
      const result = await runner.run({ message: request.message, thinkingLevel: 'off', cacheRetention: 'none' });
      if (result.meta.aborted || result.meta.error) {
        log.warn('heading model unavailable', {
          aborted: !!result.meta.aborted,
          error: result.meta.error ? String(result.meta.error).slice(0, 200) : undefined,
        });
        return { headings: [], skipped: 'model_failed' };
      }
      raw = result.text;
    }
  } catch (error) {
    log.warn('heading model call failed', { error: (error as Error).message });
    return { headings: [], skipped: 'model_failed' };
  }
  return { headings: parseHeadingResponse(raw, chunks) };
}

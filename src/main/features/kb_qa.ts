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
 *
 * Retrieval shaping (2026-09-05，针对“引用不真/看着不变”问题):
 *  - 范围跟随所在目录：`dir` 透传给 askMaterials，不再永远整库检索；
 *  - 放宽候选集后再做“每文件 ≤2 条”多样化裁减，抑制巨型文档霸榜；
 *  - 引用 chips 只保留回答文本里真实出现的 `path#chunk N` 锚点；模型
 *    漏标/明确“未找到”时不挂引用；
 *  - 按文件名提问（如「AST.pdf 讲了什么」）：若该文件在当前范围存在则置顶
 *    命中；若只存在于其它个人库目录，则返回 `suggestion` 引导用户切库重问。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import * as kbVector from './kb_vector';
import { askMaterials, formatEvidence } from '../model/core-agent/ask-materials';
import type { MaterialHit } from '../model/core-agent/material-search';

const log = createLogger('kb-qa');

export interface KbAskInput {
  /** 非空 = 空间库；空 = 个人资料库。 */
  spaceId?: string | null;
  /** 空 = 个人资料库整库；非空 = 个人库该目录（含子目录）。 */
  dir?: string | null;
  question: string;
  /** 返回给渲染层的引用条数上限（默认 8）。 */
  k?: number;
  /** 本次提问挂载的附件（本地文件绝对路径），内容作为补充上下文。 */
  attachPaths?: string[];
  /** 多轮对话历史（不含当前问），拼进 systemPrompt 供模型参考。 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
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
  /** 共享库（scope='space'）引用跳转原文所需；个人库留空。 */
  spaceId?: string;
}

/** 跨库引导：当前个人库目录没找到，但另一个个人库目录有对应内容。 */
export interface KbCrossLibSuggestion {
  /** 目标个人库目录（rel_path 首段）。 */
  dir: string;
  path: string;
  chunkIdx: number;
  snippet: string;
}

export interface KbAskEvent {
  type: 'delta' | 'final' | 'error';
  text?: string;
  /** 证据包：final 时携带，渲染层据此绘制引用 chip（点击回跳原文）。 */
  evidence?: KbEvidenceRef[];
  noMaterial?: boolean;
  reason?: 'no_material' | 'low_confidence';
  /** 明确“未找到/无相关”结论：渲染层据此把回答按浅灰提示块展示。 */
  notFound?: boolean;
  /** 未找到时若其它个人库目录有对应内容，渲染层展示“前往该库提问”引导。 */
  suggestion?: KbCrossLibSuggestion | null;
  /** 系统状态行（如“已读取知识库信息”），渲染层以浅灰小字置于回答顶部。 */
  sysNote?: string | null;
}

const KB_SYSTEM_PROMPT = `你是知识库问答助手。只依据提供的 ask_materials 证据回答；每条结论都标注引用 \`path#chunk N\`；资料里没有的内容明确归入「资料未说明」，不编造、不联网。

回答结构请遵循：
1. 开头先用一句话直接给出结论或一句话概括（如问“X 是什么”，第一句就给定义与定位，不要埋在大段中间）。
2. 再按信息类型分节组织（如「是什么 / 任务要求 / 评分规则 / 复盘要求」）；同类型多条用列表逐条列出，每条一行为宜，避免长句堆砌、整段照抄原文。需要区分类型时可用 emoji 前缀，如 📋 规则 / 📎 提交证据 / 📝 复盘要求。
3. 对关键概念与指标做必要的解读：它要求什么、与问题或其它概念的关系，用自己的话简短说明，不只做摘录搬运。
4. 全文先结论后细节；确实未找到的信息单列「资料未说明：…」如实说明，不脑补未给出的维度或定义。`;

/** 元问题（询问助手能力/身份）：不走资料检索，直接给能力说明。 */
const META_QUESTION_RE = /你会(做|干|啥)|你能(做|干|啥)|你会什么|你能什么|你有什么(功能|用|能力)|你是谁|介绍一下你(自己)?|你的(能力|功能|职责|作用)(是|都)/i;

const KB_META_ANSWER = `我是「知识库问答助手」，只基于你当前选定的知识库资料回答，不做联网搜索或凭空编造。我能帮你：

• 讲解某个文件讲了什么（例如「初中词汇-8词-真实试跑.md 讲了什么」）；
• 按资料归纳要点，区分「是什么 / 任务要求 / 评分规则 / 复盘要求」；
• 先给一句话结论再做解读，并标注「资料来源」供你点开溯源；资料里没有的会如实列为「资料未说明」。
你可以直接问具体内容；若内容在其它个人库目录，我会提示你切换过去提问。`;

/** 全库概览类问题（“这个知识库讲了什么/总结一下”）：走 AI 解析(kb.summary)，不走单点检索。 */
const LIBRARY_OVERVIEW_RE = /(这个|该|当前|整个)?(知识库|资料库|这个库|该库|当前库)(里|中)?(的)?(主要)?(讲(的)?什么|讲了什么|说什么|什么内容|有什么|包含什么|是什么|干什么的|主题|有哪些|内容|介绍|总结)|(总结|概括|介绍)一下?.*(知识库|资料库)|(知识库|资料库|这个库|该库).*(讲什么|讲的什么|说了什么|总结|介绍)/i;

const DEFAULT_K = 8;
/** material-search 单次候选集上限（其内部还会 clamp 到 30）。 */
const MAX_CANDIDATE_K = 30;
/** 最终引用里同一个文件最多保留的条数（防巨型文档霸榜、让引用分散到多个来源）。 */
const DIVERSIFY_PER_FILE = 2;
/** 文件名置顶命中使用的参考分（高于默认阈值即可，不参与真实语义比较）。 */
const PIN_SCORE = 0.02;
/** 文件名置顶最多取前几个 chunk。 */
const PIN_CHUNK_CAP = 2;

/** 可被当作“文件名提问”识别的扩展名。 */
const FILE_EXT = '(?:pdf|md|markdown|docx?|xlsx?|pptx?|doc|xls|ppt|txt|csv|html?|htm|json|png|jpe?g|gif|svg)';
const FILE_NAME_RE = new RegExp(`([^\\s，。？！?！、,;:：;'"“”‘’（）()\\[\\]【】<>]+?\\.${FILE_EXT})\\b`, 'i');

/**
 * 库级"构成"线索（硬）：这些词只在"整个库"层面成立——没有任何一个 chunk 会写
 * "本知识库的整体定位/覆盖范围"，单点检索结构上必然答不出来。因此命中即直接
 * 走全库概览，不再浪费一轮检索 + 证据作答。
 */
const LIBRARY_META_CUE_RE = /(定位|覆盖范围|覆盖|范围|涵盖|收录|概览|综述|主题分布|题材分布|类型分布|分类|体系|结构|清单|目录|都放|放了些什么|收纳)/;
/**
 * 库级"问法"线索（软）：中文里"问整个库"和"问库内某个主题"没有干净的词边界
 * （「这个知识库是干什么用的」和「这个知识库有哪些关于冒烟测试的内容」都含
 * 库级主体），所以这些词**不用于抢先路由**，只作为"证据作答失败之后"的兜底判据。
 */
const LIBRARY_SOFT_CUE_RE = /(目的|用途|目标|干什么|做什么|涉及|是否包含|包含|讲什么|讲了什么|说的是什么|什么内容|内容|主题|介绍|总结|概括|是什么|有什么|有哪些)/;
/** 指向"某一份具体文档"的线索：命中说明是文档级问题，不能被库级路由抢走。 */
const DOC_LEVEL_CUE_RE = new RegExp(
  `${FILE_NAME_RE.source}|《[^》]{1,40}》|这(份|篇|个|些)?(文档|文件|资料|材料|报告)|该(文档|文件)|第\\s*\\d+\\s*[章节]`,
);
/** 库级主体：明确指向"整个库"而非某份文档。 */
const LIBRARY_SCOPE_RE = /(知识库|资料库|这个库|该库|当前库|全库|整个库|所有资料|全部资料)/;

/**
 * 是否属于"全库概览"类问题（→ 直接走 AI 解析 kb.summary，不走单点检索）。
 *
 * 为什么必须做这条判定：库级元问题（整体定位 / 覆盖范围 / 建设目的 / 主题分布）
 * 的答案不由任何单个 chunk 承载。这类问题落到检索路由后，模型受证据作答契约
 * 约束（只依据证据、不编造），只能逐条回「资料未说明」，用户看到的就是"答非所问"。
 *
 * 判定顺序：先做"文档级"硬排除，再用原有口径，最后用「库级主体 + 库级构成线索」
 * 补足自然表述（原口径要求关键词紧跟"知识库"之后，"这个知识库的整体定位是什么"
 * 「这个知识库是干什么用的」都识别不到）。
 */
export function isLibraryOverviewQuestion(question: string): boolean {
  const q = String(question || '').trim();
  if (!q) return false;
  if (DOC_LEVEL_CUE_RE.test(q)) return false;
  if (LIBRARY_OVERVIEW_RE.test(q)) return true;
  return LIBRARY_SCOPE_RE.test(q) && LIBRARY_META_CUE_RE.test(q);
}

/**
 * 是否属于"在问整个库"（软判据，**仅用于证据作答失败后的兜底**）。
 *
 * 与 isLibraryOverviewQuestion 的区别：它判得更宽（把「干什么用的」「主要涉及
 * 什么内容」「是否包含 X」这类自然问法也算进来），但只在两条失败路径上使用——
 * 检索空手而归、或模型回答整体是「资料未说明」。此时不动手的结果是用户拿到一句
 * 无用回答，动手最差也只是给一份全库概览，因此放宽是划算的。
 */
export function isLibraryScopeQuestion(question: string): boolean {
  const q = String(question || '').trim();
  if (!q) return false;
  if (DOC_LEVEL_CUE_RE.test(q)) return false;
  return LIBRARY_SCOPE_RE.test(q) && (LIBRARY_META_CUE_RE.test(q) || LIBRARY_SOFT_CUE_RE.test(q));
}

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

/** 单文件条数封顶的多样化：保持检索排序，每个 (scope,path) 至多取 cap 条。 */
export function diversifyHits(hits: MaterialHit[], cap: number, limit?: number): MaterialHit[] {
  const counts = new Map<string, number>();
  const out: MaterialHit[] = [];
  for (const h of hits) {
    if (limit != null && out.length >= limit) break;
    const key = `${h.scope}\u0000${h.path}`;
    const c = counts.get(key) || 0;
    if (c >= cap) continue;
    counts.set(key, c + 1);
    out.push(h);
  }
  return out;
}

/** 回答文本是否真正引用了该证据锚点。优先全路径精确匹配；再容忍只用文件名 + `#chunk N`。 */
export function isAnchorCited(answer: string, r: { path: string; chunkIdx: number }): boolean {
  const exact = `${r.path}#chunk ${r.chunkIdx}`;
  if (answer.includes(exact)) return true;
  const base = r.path.slice(r.path.lastIndexOf('/') + 1);
  return base !== r.path && answer.includes(`${base}#chunk ${r.chunkIdx}`);
}

/** 回答是否为明确的“未找到相关内容”声明。此时不挂引用 chips（没有支撑证据可展示）。 */
export function isNotFoundAnswer(answer: string): boolean {
  return /资料未说明|资料[中内]?未找到|未找到(任何|与|关于)?(相关)?(的)?(内容|资料|文档|文件|定义)|没有(找到|检索到)?(任何)?(与|关于)?.*(相关内容|相关资料)|未检索到|未查找到|未提供.*(定义|说明|内容)/.test(
    String(answer || ''),
  );
}

/** 从问题文本里识别“按文件名提问”的目标文件名（如 AST.pdf / 初中词汇.md）。 */
export function detectTargetFilename(question: string): string | null {
  const m = String(question || '').match(FILE_NAME_RE);
  if (!m) return null;
  let raw = m[1].trim();
  raw = raw.replace(/^[`'"“”‘’([【\u300a]+|[`'"“”‘’)\]]*\u300b?[）)\]】]+$/g, '');
  const base = raw.slice(raw.lastIndexOf('/') + 1).trim();
  return base || null;
}

/** rel_path 是否在 dir 范围内（dir 为空 = 整库）。 */
function isWithinScope(relPath: string, dir: string | null): boolean {
  if (!dir) return true;
  return relPath === dir || relPath.startsWith(`${dir}/`);
}

/** 顶层目录（rel_path 第一段）；根级文件返回 null。 */
function topDirOf(relPath: string): string | null {
  const idx = relPath.indexOf('/');
  return idx > 0 ? relPath.slice(0, idx) : null;
}

function snippetOf(text: string): string {
  const s = (text || '').trim();
  return s.length <= 600 ? s : `${s.slice(0, 600)}…`;
}

/** 当前范围内、与文件名同名的 ready 文件（按 basename 不敏感匹配）。 */
export function findReadyByBasename(uid: string, base: string, dir: string | null): string[] {
  const want = base.toLowerCase();
  return kbVector
    .listFiles(uid)
    .filter((f) => f.status === 'ready' && isWithinScope(f.rel_path, dir))
    .filter((f) => f.rel_path.slice(f.rel_path.lastIndexOf('/') + 1).toLowerCase() === want)
    .map((f) => f.rel_path);
}

/** 给目标文件前 N 个 chunk 做置顶候选（保证“按文件名提问”能命中该文件）。 */
export function pinnedHitsForFile(uid: string, relPath: string): MaterialHit[] {
  const chunks = kbVector.readFileChunks(uid, relPath) || [];
  return chunks.slice(0, PIN_CHUNK_CAP).map((c) => ({
    source: 'library' as const,
    scope: 'global' as const,
    path: relPath,
    chunkIdx: c.chunk_idx,
    title: c.title,
    snippet: snippetOf(c.content),
    score: PIN_SCORE,
  }));
}

/** 跨库定位：文件名整库查找优先，其次整库语义检索；仅个人库目录场景使用。 */
async function resolveCrossLibSuggestion(
  userId: string,
  input: { question: string; dir: string | null; spaceId?: string | null },
): Promise<KbCrossLibSuggestion | null> {
  const dir = input.dir;
  if (!dir || input.spaceId) return null; // 整库提问没有“其它目录”；空间库本期不做
  const question = String(input.question || '').trim();

  // tier-1：按文件名在整库找，命中的顶层目录不同于当前目录 → 引导
  const fname = detectTargetFilename(question);
  if (fname) {
    const want = fname.toLowerCase();
    const others = kbVector
      .listFiles(userId)
      .filter((f) => f.status === 'ready' && f.rel_path.slice(f.rel_path.lastIndexOf('/') + 1).toLowerCase() === want)
      .filter((f) => !isWithinScope(f.rel_path, dir));
    if (others.length) {
      const hit = others[0];
      const top = topDirOf(hit.rel_path);
      if (top) {
        const chunks = kbVector.readFileChunks(userId, hit.rel_path) || [];
        const first = chunks[0];
        return {
          dir: top,
          path: hit.rel_path,
          chunkIdx: first?.chunk_idx ?? 0,
          snippet: first ? snippetOf(first.content) : '',
        };
      }
    }
  }

  // tier-2：整库语义检索，取 top 命中做引导
  try {
    const res = await askMaterials({ userId, query: question, scope: 'global', k: 6 });
    if (res.hasEvidence && res.hits.length) {
      const best = res.hits[0];
      if (best.scope === 'global') {
        const top = topDirOf(best.path);
        if (top && top !== dir) return { dir: top, path: best.path, chunkIdx: best.chunkIdx, snippet: best.snippet };
      }
    }
  } catch (err) {
    log.warn('cross-lib suggestion topic search failed', {
      user_id: maskId(userId),
      error: (err as Error).message,
    });
  }
  return null;
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
  // 元问题（问助手会什么/你是谁等）：不走资料检索，直接给能力说明。
  // 这类问题问的是助手自身，资料库里本就不该有“助手能力”条目。
  if (META_QUESTION_RE.test(question)) {
    yield { type: 'final', text: KB_META_ANSWER, evidence: [] };
    return;
  }
  const dirScope =
    typeof input.dir === 'string' && input.dir.trim()
      ? input.dir.trim().replace(/^\/+|\/+$/g, '') || null
      : null;

  // 全库概览类问题：复用「AI 解析」能力（一句话总结 + 逐文档要点），
  // 避免单点检索对“整个库讲什么”必然空手而归。
  if (isLibraryOverviewQuestion(question)) {
    const reply = await buildOverviewReply();
    if (reply) {
      // 记一条路由决策：否则"直达概览"这条路径在日志里完全静默，出问题时
      // 没法判断用户问的到底走了哪条路（2026-09 验收排查吃过这个亏）。
      log.info('kb library question routed to overview (no retrieval)', {
        user_id: maskId(userId),
        dir: dirScope,
        query: question.slice(0, 120),
      });
      yield reply;
      return;
    }
  }
  /**
   * 全库概览答复（复用「AI 解析」kb.summary）。
   * 返回 null = 摘要不可用，调用方应回落到单点检索。
   * 之所以抽成函数：它有两个使用点——库级问题直接走它；以及"证据作答失败后"的兜底。
   */
  async function buildOverviewReply(): Promise<KbAskEvent | null> {
    try {
      const kbSummaryMod = await import('./kb_summary');
      const overview = await kbSummaryMod.kbSummarize(userId, {
        dir: dirScope,
        spaceId: input.spaceId || null,
      }, {
        complete: async (opts) => {
          let txt = '';
          let err = '';
          for await (const e of deps.stream({
            userId: opts.userId,
            message: opts.message,
            systemPrompt: opts.systemPrompt,
            sessionId: opts.sessionId,
          })) {
            if (e.type === 'delta' && e.text) txt += e.text;
            else if (e.type === 'error') { err = e.text || 'kb summary failed'; break; }
          }
          return { ok: !err && !!txt.trim(), text: txt, error: err };
        },
      });
      const docs = Array.isArray(overview.docs) ? overview.docs : [];
      const scope = dirScope ? `「${dirScope}」` : '个人知识库';
      let text: string;
      if (docs.length) {
        const rows = docs.slice(0, 10).map((d, i) => {
          const point = d.text && d.text.trim() ? d.text.trim() : '（暂无要点）';
          return `${i + 1}. **${d.name}** —— ${point}`;
        }).join('\n');
        text = `${scope}共收录 ${docs.length} 份已解析文档，以下是核心内容概览：\n\n📚 文档内容\n${rows}\n\n💡 一句话总结\n${overview.oneLiner || '（未能生成总结）'}`;
      } else {
        text = `${scope}当前还没有可索引文档，导入资料后可再次总结。`;
      }
      // 概览回答同样必须可溯源：把实际参与总结的文档挂成证据，渲染层的底部
      // 「资料来源」据此渲染可点路径（与 AI 解析卡的 `路径#chunk 1 ↗` 同源字段）。
      // 此前这里恒返回 `evidence: []`，用户看到"某文档：某要点"却无从点开原文。
      const evidence: KbEvidenceRef[] = docs
        .filter((d) => d && d.file)
        .slice(0, 12)
        .map((d) => ({
          source: 'library' as const,
          scope: (input.spaceId ? 'space' : 'global') as KbEvidenceRef['scope'],
          path: String(d.file),
          chunkIdx: 1,
          snippet: String(d.text || ''),
          score: 1,
          ...(input.spaceId ? { spaceId: String(input.spaceId) } : {}),
        }));
      // 状态行与正文分离：渲染层以浅灰小字置于回答顶部（sysNote 随事件回传，见调用点 yield）
      return { type: 'final', text, evidence, sysNote: '已读取知识库信息' };
    } catch (err) {
      log.warn('library-overview summary failed; falling back to normal retrieval', {
        user_id: maskId(userId),
        error: (err as Error).message,
      });
      return null;
    }
  }
  const finalK = typeof input.k === 'number' && input.k > 0 ? Math.floor(input.k) : DEFAULT_K;
  const dir = dirScope;

  let res;
  try {
    res = await askMaterials({
      userId,
      query: question,
      scope: input.spaceId ? 'space' : 'global',
      spaceId: input.spaceId || undefined,
      dir: dir || undefined,
      // 放宽候选集供“每文件封顶”多样化裁减；material-search 会 clamp 到 30。
      k: Math.min(MAX_CANDIDATE_K, Math.max(finalK * 3, finalK)),
    });
  } catch (err) {
    log.warn('ask_materials failed', { user_id: maskId(userId), error: (err as Error).message });
    yield { type: 'error', text: (err as Error).message };
    return;
  }

  // 按文件名提问且该文件在当前范围存在：置顶命中，避免检索不到文件本身。
  const hadEvidenceBeforePin = res.hasEvidence;  const fname = detectTargetFilename(question);
  const pinned: MaterialHit[] = fname
    ? findReadyByBasename(userId, fname, dir).slice(0, DIVERSIFY_PER_FILE).flatMap((p) => pinnedHitsForFile(userId, p))
    : [];
  if (pinned.length && !hadEvidenceBeforePin) {
    res = {
      ...res,
      hasEvidence: true,
      reason: undefined,
      hits: pinned,
      summary: [...res.summary, `filename hit pinned: ${fname}`],
    };
  }
  // 合并去重：pinned 优先；同 (path, chunkIdx) 只保留一次。
  const merged: MaterialHit[] = [];
  const seenKeys = new Set<string>();
  for (const h of [...pinned, ...(res.hits || [])]) {
    const key = `${h.scope}\u0000${h.path}\u0000${h.chunkIdx}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(h);
  }

  if (!res.hasEvidence) {
    // 库级兜底①：检索空手而归、而问题在问"整个库"时，改用全库概览。
    // 单点检索结构上答不出库级问题，直接回"未找到"属于答非所问。
    if (isLibraryScopeQuestion(question)) {
      const overviewReply = await buildOverviewReply();
      if (overviewReply) {
        log.info('kb library-scope question answered via overview (retrieval empty)', {
          user_id: maskId(userId),
          dir,
          query: question.slice(0, 120),
        });
        yield overviewReply;
        return;
      }
    }
    const weakEvidence = diversifyHits(res.hits, DIVERSIFY_PER_FILE, finalK);
    log.info('kbqa retrieval observed', {
      user_id: maskId(userId),
      space: input.spaceId || null,
      dir,
      query: question.slice(0, 120),
      has_evidence: false,
      reason: res.reason || null,
      hits: weakEvidence.map((h) => `${h.path}#chunk ${h.chunkIdx}@${h.score.toFixed(4)}`),
    });
    const suggestion = await resolveCrossLibSuggestion(userId, { question, dir, spaceId: input.spaceId });
    const text = res.reason === 'no_material'
      ? '资料中未找到与问题相关的内容。我是只基于当前资料库回答的问答助手：可以把问题问得更具体（例如「某文件讲了什么」），或补充资料后再问。'
      : '找到的相关资料很弱，无法给出可靠回答。建议换个问法或补充资料。';
    // 无资料/弱资料时回答本身是“未找到/存疑”声明，不挂“引用”chips。
    yield { type: 'final', text, noMaterial: true, reason: res.reason, evidence: [], notFound: true, suggestion };
    return;
  }

  const chosen = diversifyHits(merged, DIVERSIFY_PER_FILE, finalK);
  log.info('kbqa retrieval observed', {
    user_id: maskId(userId),
    space: input.spaceId || null,
    dir,
    query: question.slice(0, 120),
    has_evidence: true,
    candidates: merged.length,
    hits: chosen.map((h) => `${h.path}#chunk ${h.chunkIdx}@${h.score.toFixed(4)}`),
  });

  const evidence = toEvidenceRefs(chosen);
  const systemPrompt = `${KB_SYSTEM_PROMPT}\n\n${formatEvidence({ ...res, hits: chosen })}${await formatAttachments(userId, input.attachPaths)}${formatHistory(input.history)}`;
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

  // 引用口径：只把回答文本里真实出现的锚点当作“引用”；回答明确“未找到”时不挂
  // chips（可附跨库 suggestion）；只有模型确实作答却没标任何锚点时才回退本次证据。
  const cited = evidence.filter((r) => isAnchorCited(answer, r));
  if (cited.length) {
    yield { type: 'final', text: answer, evidence: cited };
    return;
  }
  if (isNotFoundAnswer(answer)) {
    // 库级兜底②：检索**有**证据、但模型逐条回「资料未说明」——这是库级元问题的
    // 典型结局（问题问的是"整个库的定位/覆盖/目的"，而证据里只有零散 chunk）。
    // 此时若问题在问"整个库"，改用全库概览整体回答；否则保留原本的诚实声明。
    if (isLibraryScopeQuestion(question)) {
      const overviewReply = await buildOverviewReply();
      if (overviewReply) {
        log.info('kb library-scope question answered via overview (evidence answered nothing)', {
          user_id: maskId(userId),
          dir,
          query: question.slice(0, 120),
        });
        yield overviewReply;
        return;
      }
    }
    const suggestion = await resolveCrossLibSuggestion(userId, { question, dir, spaceId: input.spaceId });
    log.info('kb answer reports nothing found; suppressing citation chips', {
      user_id: maskId(userId),
      dir,
      query: question.slice(0, 80),
      suggestion_dir: suggestion?.dir || null,
    });
    yield { type: 'final', text: answer, evidence: [], notFound: true, suggestion };
    return;
  }
  log.warn('kb answer carries no path#chunk anchors; falling back to retrieval evidence', {
    user_id: maskId(userId),
    dir,
    query: question.slice(0, 80),
  });
  yield { type: 'final', text: answer, evidence };
}

export const _internals = {
  toEvidenceRefs,
  diversifyHits,
  isAnchorCited,
  isNotFoundAnswer,
  detectTargetFilename,
  findReadyByBasename,
  pinnedHitsForFile,
  topDirOf,
  isLibraryOverviewQuestion,
  isLibraryScopeQuestion,
};

/** 多轮对话历史拼进 systemPrompt（只保留最近 6 轮，防上下文溢出）。 */
function formatHistory(history?: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  const rows = Array.isArray(history) ? history.slice(-6) : [];
  if (!rows.length) return '';
  const lines = rows.map((h) => (h.role === 'user' ? `用户：${h.content}` : `助手：${h.content}`));
  return `\n\n以下是本次会话的对话历史（供理解上下文，回答当前问题时也可参考）：\n${lines.join('\n')}`;
}

/** 读取本次提问挂载的文本类附件，作为补充上下文（非文本/过大跳过）。 */
async function formatAttachments(userId: string, attachPaths?: string[]): Promise<string> {
  const paths = Array.isArray(attachPaths) ? attachPaths.filter((p) => typeof p === 'string' && p) : [];
  if (!paths.length) return '';
  const textExts = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log', '.html', '.htm', '.xml']);
  const parts: string[] = [];
  for (const p of paths.slice(0, 5)) {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile() || st.size > 200 * 1024) continue; // 只读 ≤200KB 文本
      const ext = path.extname(p).toLowerCase();
      if (!textExts.has(ext)) continue;
      const text = await fsp.readFile(p, 'utf8');
      if (!text.trim()) continue;
      parts.push(`## 附件：${path.basename(p)}\n${text.slice(0, 6000)}`);
    } catch { /* 跳过不可读附件 */ }
  }
  if (!parts.length) return '';
  return `\n\n以下为本次提问附带的上传文件内容（回答时可参考）：\n\n${parts.join('\n\n')}`;
}

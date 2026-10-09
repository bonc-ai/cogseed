/**
 * KB library summary (知识库模块 S3，计划书 v1.3 §S3).
 *
 * Lazily produces, per library, per-document key points + a one-liner summary
 * (+ a mind-map skeleton) from the ready chunks in the vector store. The work
 * is guarded by a library fingerprint (sorted rel_path + mtime + chunk count),
 * so re-entry with an unchanged library hits an in-memory cache instead of a
 * fresh LLM call; any model failure degrades to a plain file list instead of
 * an error page (the renderer keeps the library usable).
 *
 * Read-only: never writes to chats / artifacts; one non-streaming LLM call.
 *
 * Single-shot & stateless: callers must run it against an ephemeral model session
 * (see ipc 'kb.summary'), so a failed parse that the user retries never accumulates
 * history that later triggers a ~30s context compaction on the next attempt. The
 * LLM call is also hard-aborted when the timeout fires, so a stalled provider can't
 * keep holding the model turn lock and silently delay later turns.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import * as kbVector from './kb_vector';
import * as spaceLibrary from './project_library_indexer';

const log = createLogger('kb-summary');

export interface KbDocPoint {
  /** 文档名（文件名）。 */
  name: string;
  /** 相对路径（引用 chip 的 path）。 */
  file: string;
  /** 一句话要点。 */
  text: string;
}

export interface KbSummaryResult {
  docs: KbDocPoint[];
  oneLiner: string;
  mindmap: { root: string; kids: string[] };
  source: 'generated' | 'cached' | 'degraded';
  /** 库指纹（渲染层可据此判断是否过期）。 */
  fingerprint: string;
}

export interface KbSummaryDeps {
  /** Injected model call — keeps this module testable without a live provider. */
  complete: (opts: {
    userId: string;
    message: string;
    systemPrompt: string;
    sessionId: string;
    /** 超时中止信号：接线方应透传给 chatWithModel.abortSignal。 */
    signal?: AbortSignal;
  }) => Promise<{ ok: boolean; text: string; error: string }>;
}

/**
 * 要点采样预算（2026-09-16 重写）。
 *
 * 旧值 `CHUNKS_PER_FILE=2 / CHUNK_CHAR_CAP=300 / DOC_CHAR_CAP=900` 把长文档截成
 * "封面"：一篇 5,531 字的文章只送 427 字进 prompt，模型连第一个小节标题都没看到，
 * 脑图/要点/测验全部退化成标题复述。新策略见 `sampleDocLines`——标题块优先 +
 * 全文等距覆盖，预算按 token 量级放开（中文 1 字 ≈ 1 token）。
 */
const CHUNK_CHAR_CAP = 800; // 每 chunk 截断字符
const DOC_CHAR_CAP = 12000; // 每文件拼进 prompt 的字符上限（短文档可整篇进）
const TOTAL_CHAR_CAP = 40000; // 整个库拼进 prompt 的总字符上限（按文件数摊分，≈30k token）
const FILES_CAP = 10; // 单库最多纳入的文件数
const CACHE_MAX = 50;
/** LLM 单次解析超时。先 abort 上游请求（释放模型 turn 锁、停止浪费生成）再降级，
 *  避免 UI 无限"正在解析…"。180s 与 kb_mindmap 对齐（采样预算放开到最多 30k 字后，
 *  120s 会开始误杀正常请求），覆盖慢端点首字数十秒的真实完成时间。 */
const SUMMARY_LLM_TIMEOUT_MS = 180 * 1000;

/** 超时 + 中止：到点先 abort（真正停掉服务端生成、释放单飞模型锁），再以超时错误
 *  reject。比"只 reject 不取消"干净——被掐断的请求不会继续占着模型锁拖慢后续调用。 */
function withTimeout<T>(p: Promise<T>, ctrl: AbortController, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`LLM timeout after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const SUMMARY_SYSTEM_PROMPT = `你是知识库整理助手。根据提供的各文档要点，只输出一个 JSON 对象（不要任何额外文字）：
{"docs":[{"name":"文档名","file":"相对路径","text":"一句话要点"}],"oneLiner":"整个知识库的一句话总结","mindmap":{"root":"中心主题","kids":["分支1","分支2","分支3"]}}`;

const cache = new Map<string, KbSummaryResult>();
// 同 key（用户+库）的解析 in-flight 去重：并发调用共享同一 Promise，
// 避免切换库来回触发重复的 LLM 推理。
const inFlight = new Map<string, Promise<KbSummaryResult>>();

function fingerprint(files: Array<{ path: string; mtime: number; chunks: number }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}\u0000${f.mtime}\u0000${f.chunks}\u0000`);
  }
  return h.digest('hex').slice(0, 16);
}

export function parseSummaryJson(text: string): { docs: KbDocPoint[]; oneLiner: string; mindmap: { root: string; kids: string[] } } {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  const data = m ? JSON.parse(m[0]) : {};
  const docs = Array.isArray(data.docs)
    ? data.docs
        .map((d: any) => ({
          name: String(d?.name ?? ''),
          file: String(d?.file ?? ''),
          text: String(d?.text ?? ''),
        }))
        .filter((d: KbDocPoint) => d.file)
    : [];
  const oneLiner = typeof data.oneLiner === 'string' ? data.oneLiner : '';
  const kids = Array.isArray(data?.mindmap?.kids) ? data.mindmap.kids.map(String).filter(Boolean) : [];
  const root = typeof data?.mindmap?.root === 'string' ? data.mindmap.root : '';
  return { docs, oneLiner, mindmap: { root, kids } };
}

interface DocChunkRow {
  chunk_idx: number;
  title: string | null;
  content: string;
}

/**
 * 乱码块判定（旧索引里图片内联 base64 的残留）：既无信息又极占预算，直接丢。
 *
 * 判据分两级，因为 base64 被切块后**只有第一块带 `base64,` 标记**，其余都是纯乱码：
 *   1. 带 `base64,` 标记 → 丢；
 *   2. 含 CJK（中/日/韩）→ 一定是正文，留；
 *   3. 无 CJK 时看空白：真实西文正文（词组之间）与逐行文本一定含空格/换行，
 *      而 base64 切块是**一整条无空白的长 token** → 丢。
 *
 * 这一条很重要：真机老索引里 2871 个 chunk 有 2847 个是图片乱码，而它们
 * 有一半逃过了"纯 base64 字符集"正则，最终挤掉正文槽位（实测把「六｜…」
 * 这一节挤出了 prompt）。
 */
function isNoiseChunk(content: string): boolean {
  const t = String(content || '').trim();
  if (!t) return true;
  if (t.includes('base64,')) return true;
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(t)) return false;
  return !/\s/.test(t);
}

/** 标题已在正文开头时不再前缀，避免 `标题：标题…` 的重复（真机出现过）。 */
function withTitle(title: string | null | undefined, content: string): string {
  const body = String(content || '').trim();
  const t = String(title || '').trim();
  if (!t) return body;
  if (body.startsWith(t) || body.slice(0, 60).includes(t)) return body;
  return `${t}：${body}`;
}

/** 等距取 k 项（含首尾），保证覆盖整篇而不是只看开头。 */
function evenSample<T>(items: T[], k: number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return items.slice();
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < k; i++) {
    const idx = Math.round((i * (items.length - 1)) / Math.max(1, k - 1));
    if (!seen.has(idx)) { seen.add(idx); out.push(items[idx]); }
  }
  return out;
}

/**
 * 单文件要点采样（纯函数，便于单测）。
 *
 * 原实现是"取前 2 个 chunk、每 chunk 截 300 字、每文件总截 900 字"——对长文档
 * 等于只喂封面：真机案例一篇 5,531 字的文章只送去 427 字，连第一个小节标题
 * (`一｜政策方向…`，第 3 个 chunk) 都没进 prompt，生成的脑图只剩标题句。
 *
 * 现改为**结构优先 + 全文等距覆盖**：
 *   1. 丢弃 base64 乱码块（旧索引里图片内联残留）；
 *   2. 预算内优先收全部"带标题的 chunk"（标题块 = 章节骨架，正是脑图一级分支）；
 *   3. 剩余预算对全文等距取样，而不是从头截断；
 *   4. 槽位数不足时**逐格收缩重算**，绝不"先选好再从尾部砍"——本轮实现中实测：
 *      先选后砍会把老索引里的「六｜…」静默丢弃（输出 5,808 字里没有最后一节），
 *      改成收缩重算后同一份数据六节齐全；
 *   5. 输出仍按文档原序，模型看到的是顺序文本。
 */
export function sampleDocLines(rows: DocChunkRow[], budget: number = DOC_CHAR_CAP): string {
  const clean = (rows || [])
    .filter((r) => r && !isNoiseChunk(String(r.content || '')))
    .map((r) => ({
      idx: r.chunk_idx,
      heading: Boolean(String(r.title || '').trim()),
      text: withTitle(r.title, String(r.content || '')).slice(0, CHUNK_CHAR_CAP),
    }));
  if (!clean.length) return '';

  const size = (list: typeof clean) => list.reduce((a, c) => a + c.text.length + 2, 0);
  const total = size(clean);
  if (total <= budget) return clean.map((c) => c.text).join('\n\n');

  // 预算不够时按"字数"而不是"块数"分配，避免长块把预算吃光。
  const avg = Math.max(1, total / clean.length);
  const headings = clean.filter((c) => c.heading);
  const bodies = clean.filter((c) => !c.heading);

  /** 给定槽位数选块：标题块（骨架）优先，其余等距补足；返回结果仍按文档原序。 */
  const pick = (slots: number) => {
    const keepHeadings = headings.length <= slots ? headings : evenSample(headings, slots);
    const keepBodies = evenSample(bodies, Math.max(0, slots - keepHeadings.length));
    const kept = new Set([...keepHeadings, ...keepBodies].map((c) => c.idx));
    return clean.filter((c) => kept.has(c.idx));
  };

  let slots = Math.max(1, Math.min(clean.length, Math.floor(budget / avg)));
  let picked = pick(slots);
  while (slots > 1 && size(picked) > budget) {
    slots -= 1;
    picked = pick(slots);
  }
  if (size(picked) <= budget) return picked.map((c) => c.text).join('\n\n');

  // 兜底：只剩一格仍超预算（单块极长）时按格硬截，保证结果一定 ≤ budget。
  const perItem = Math.max(1, Math.floor(budget / picked.length) - 2);
  return picked.map((c) => c.text.slice(0, perItem)).join('\n\n');
}

/**
 * `doc` 的宽容解析：先精确匹配，再按 Unicode 归一化（NFC/NFD 在 macOS 上是同一个
 * 文件的两种字节形式）匹配，最后退到"文件名唯一"匹配。
 *
 * 为什么需要宽容：`doc` 是渲染层从库树里取的名字，索引里的 `rel_path` 是索引时
 * 从磁盘读的名字；两者只要在规范化形式上有一点差异，精确相等就会落空 → 用户看到
 * "这份文档不在已索引列表里"，而文件其实好好地在索引里（真机 2026-09-16 就撞过）。
 * 注意返回的是**解析到的真实 rel_path**，调用方据此回执，绝不猜一个不存在的路径。
 */
function resolveDocPath(files: Array<{ rel_path: string }>, doc: string): string | null {
  const exact = files.find((f) => f.rel_path === doc);
  if (exact) return exact.rel_path;
  const want = doc.normalize('NFC');
  const normHit = files.find((f) => f.rel_path.normalize('NFC') === want);
  if (normHit) return normHit.rel_path;
  const base = want.split('/').pop() || '';
  const sameBase = files.filter((f) => (f.rel_path.normalize('NFC').split('/').pop() || '') === base);
  return sameBase.length === 1 ? sameBase[0].rel_path : null;
}

/**
 * 收集当前库 ready 文档的要点（kb_summary / kb_mindmap / kb_quiz 共用同源）。
 *
 * 返回**带文件路径**的条目，供调用方做作用域回执校验（见 kb_mindmap 的 `scope`/`files`）——
 * 只返回拼接好的文本的话，调用方无法证明"这次到底读了哪些文件"。
 *
 * `doc`：单文档模式——**只读这一个文件**的 chunk，并给足整库预算（文档级脑图用）。
 * 注意这里的过滤是**硬约束**：`doc` 给了就绝不回退到库级读取（否则一旦上游把参数
 * 丢了/改了名，就会静默画成"整库脑图"，真机事故见 kb_mindmap.ts 的 scope 注释）。
 */
export function collectReadyDocs(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null; doc?: string | null; onMiss?: (info: { reason: string; candidates: number }) => void },
): Array<{ path: string; text: string }> {
  const dir = opts?.dir || null;
  const spaceId = opts?.spaceId || null;
  const doc = opts?.doc || null;
  const isSpace = !!spaceId;
  let ready;
  if (isSpace) {
    const all = spaceLibrary.listFiles(userId, spaceId).filter((f) => f.status === 'ready');
    ready = doc
      ? all.filter((f) => f.rel_path === resolveDocPath(all, doc)).slice(0, 1)
      : all.slice(0, FILES_CAP);
    if (doc && !ready.length) opts?.onMiss?.({ reason: 'not-found', candidates: all.length });
  } else {
    const all = kbVector.listFiles(userId).filter((f) => f.status === 'ready');
    const scoped = doc ? all : all.filter((f) => !dir || f.rel_path === dir || f.rel_path.startsWith(`${dir}/`));
    if (doc) {
      const hit = resolveDocPath(scoped, doc);
      ready = hit ? scoped.filter((f) => f.rel_path === hit).slice(0, 1) : [];
      if (!ready.length) opts?.onMiss?.({ reason: 'not-found', candidates: scoped.length });
    } else {
      ready = scoped.slice(0, FILES_CAP);
    }
  }
  // 总预算按文件数摊分：文件多时单文件少给，保证整轮 prompt 不超 TOTAL_CHAR_CAP。
  const perFile = ready.length
    ? Math.max(CHUNK_CHAR_CAP, Math.min(DOC_CHAR_CAP, Math.floor(TOTAL_CHAR_CAP / ready.length)))
    : DOC_CHAR_CAP;
  const out: Array<{ path: string; text: string }> = [];
  for (const f of ready) {
    const chunks = isSpace
      ? spaceLibrary.readFileChunks(userId, spaceId, f.rel_path)
      : kbVector.readFileChunks(userId, f.rel_path);
    const head = sampleDocLines(chunks || [], perFile);
    if (!head) continue;
    out.push({ path: f.rel_path, text: `## ${f.rel_path}\n${head}` });
  }
  return out;
}

/** 只要拼接文本的老接口（kb_summary / kb_quiz 用；二者不需要作用域回执）。 */
export function collectReadyDocLines(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null; doc?: string | null },
): string[] {
  return collectReadyDocs(userId, opts).map((d) => d.text);
}

export async function kbSummarize(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null },
  deps: KbSummaryDeps,
): Promise<KbSummaryResult> {
  const dir = opts?.dir || null;
  const spaceId = opts?.spaceId || null;
  const isSpace = !!spaceId;
  const inFlightKey = `${userId}\u0000${spaceId || 'lib'}\u0000${dir || ''}`;
  const existing = inFlight.get(inFlightKey);
  if (existing) return existing; // 同一库已在解析中，复用结果

  const run = kbSummarizeInner(userId, opts, deps, inFlightKey);
  inFlight.set(inFlightKey, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(inFlightKey) === run) inFlight.delete(inFlightKey);
  }
}

async function kbSummarizeInner(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null },
  deps: KbSummaryDeps,
  inFlightKey: string,
): Promise<KbSummaryResult> {
  const dir = opts?.dir || null;
  const spaceId = opts?.spaceId || null;
  const isSpace = !!spaceId;
  let ready;
  if (isSpace) {
    ready = spaceLibrary
      .listFiles(userId, spaceId)
      .filter((f) => f.status === 'ready')
      .slice(0, FILES_CAP);
  } else {
    ready = kbVector
      .listFiles(userId)
      .filter((f) => f.status === 'ready')
      .filter((f) => !dir || f.rel_path === dir || f.rel_path.startsWith(`${dir}/`))
      .slice(0, FILES_CAP);
  }
  const fp = fingerprint(
    ready.map((f) => ({ path: f.rel_path, mtime: f.mtime || 0, chunks: f.chunks || 0 })),
  );

  const hit = cache.get(fp);
  if (hit) return { ...hit, source: 'cached' };

  if (!ready.length) {
    const degraded: KbSummaryResult = {
      docs: [],
      oneLiner: '资料库还没有已索引的文档。',
      mindmap: { root: '', kids: [] },
      source: 'degraded',
      fingerprint: fp,
    };
    return degraded;
  }

  const docLines = collectReadyDocLines(userId, { dir, spaceId });

  const ctrl = new AbortController();
  try {
    // 会话按单发无状态运行（接线方以 ephemeralSession 调用，见 ipc 'kb.summary'）：
    // 不累积历史，避免失败重试后触发 ~30s 的上下文压缩。超时先 abort 再降级。
    const res = await withTimeout(
      deps.complete({
        userId,
        message: `请整理以下知识库文档要点：\n\n${docLines.join('\n\n')}`,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        sessionId: `aside-kbsummary-${userId}`,
        signal: ctrl.signal,
      }),
      ctrl,
      SUMMARY_LLM_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error || 'model failed');
    const parsed = parseSummaryJson(res.text);
    const result: KbSummaryResult = {
      docs: parsed.docs,
      oneLiner: parsed.oneLiner || '（未生成总结）',
      mindmap: parsed.mindmap,
      source: 'generated',
      fingerprint: fp,
    };
    cache.set(fp, result);
    if (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return result;
  } catch (err) {
    log.warn('kb summary failed, degrading to file list', {
      user_id: maskId(userId),
      dir: dir || null,
      error: (err as Error).message,
    });
    return {
      docs: ready.map((f) => ({
        name: f.rel_path.split('/').pop() || f.rel_path,
        file: f.rel_path,
        text: '',
      })),
      oneLiner: 'AI 解析失败，已降级为文件清单。',
      mindmap: { root: '', kids: [] },
      source: 'degraded',
      fingerprint: fp,
    };
  }
}

export const _internals = { fingerprint, parseSummaryJson, clearCacheForTests: () => cache.clear() };

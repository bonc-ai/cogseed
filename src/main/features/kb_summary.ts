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

const CHUNKS_PER_FILE = 2; // 每文件取前 N 个 chunk
const CHUNK_CHAR_CAP = 300; // 每 chunk 截断字符
const DOC_CHAR_CAP = 900; // 每文件拼进 prompt 的总字符上限
const FILES_CAP = 10; // 单库最多纳入的文件数
const CACHE_MAX = 50;
/** LLM 单次解析超时。先 abort 上游请求（释放模型 turn 锁、停止浪费生成）再降级，
 *  避免 UI 无限"正在解析…"。120s 与 kb_mindmap 对齐，覆盖慢端点首字数十秒的真实完成时间。 */
const SUMMARY_LLM_TIMEOUT_MS = 120 * 1000;

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

/** 收集当前库 ready 文档的要点行（kb_summary / kb_mindmap 共用同源）。 */
export function collectReadyDocLines(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null },
): string[] {
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
  const docLines: string[] = [];
  for (const f of ready) {
    const chunks = isSpace
      ? spaceLibrary.readFileChunks(userId, spaceId, f.rel_path)
      : kbVector.readFileChunks(userId, f.rel_path);
    const head = (chunks || [])
      .slice(0, CHUNKS_PER_FILE)
      .map((c) => (c.title ? `${c.title}：` : '') + String(c.content || '').slice(0, CHUNK_CHAR_CAP))
      .join('\n');
    docLines.push(`## ${f.rel_path}\n${head.slice(0, DOC_CHAR_CAP)}`);
  }
  return docLines;
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

/**
 * KB multi-level mind map (知识库多级脑图，本地化 notebooklm mind-map 协议).
 *
 * 改造自 `NotebookLM相关skill/notebooklm`：保留其 mind-map 的**层级 JSON 产物协议**
 * （`{"root":{"label","children":[…]}}`，供可视化工具），但数据源/执行引擎从
 * Google NotebookLM 云换为 CogSeed 本地——基于库内 ready 文档要点（与 kb_summary
 * 同源），由本地 LLM（DeepSeek）生成 2–3 层层级树，全程不上云。
 *
 * 只读管线：不写 chats/artifacts；库指纹缓存；失败降级为单节点。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import { WS_ROOT } from '../paths';
import { collectReadyDocs } from './kb_summary';

const log = createLogger('kb-mindmap');
const CACHE_MAX = 50;
/** 基于对话文本生成时的输入截断（防止超长回答撑爆 LLM 上下文） */
const DOC_CHAR_CAP = 4000;
/** LLM 单次脑图生成超时（网络不可达/模型卡住时降级为单节点，避免 UI 无限等待）。
 *  注意该预算包含「模型 turn 排队等待 + 模型推理 + 流式输出」全程：实测
 *  DeepSeek 高峰期单次响应可达 60–90s，若用户同时跑 agent 长对话还会叠加排队，
 *  45s 会把正常请求误杀成单节点，故放宽到 120s。超时仍降级，且迟到结果会被缓存
 *  （见 runMindAttempt 的 late-cache），重试可秒出，不会每次都干等。
 *  2026-09-16：采样预算从 ~900 字放开到最多 30k 字（`kb_summary.collectReadyDocLines`），
 *  prefill 与输出（最多 120 节点）都显著变长，120s 会开始误杀正常请求 → 放宽到 180s，
 *  与 kb_summary 的 SUMMARY_LLM_TIMEOUT_MS 保持同一预算。 */
const MIND_LLM_TIMEOUT_MS = 180 * 1000;

/** 给 Promise 加超时：超时 reject（调用方 catch 后降级）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export interface KbMindNode {
  label: string;
  children: KbMindNode[];
  /** 节点内容主要来源文档名（溯源用，可选）。 */
  source?: string;
}

/** 脑图作用域。renderer 请求了哪个作用域，就必须收到同一个作用域的回执。 */
export type KbMindScope = 'doc' | 'dir' | 'space' | 'text';

export interface KbMindResult {
  root: KbMindNode;
  source: 'generated' | 'cached' | 'degraded';
  /** 降级原因（source='degraded' 时存在），供 UI 区分提示与重试引导：
   *  - empty        ：库内没有 ready 文档要点，根本没调 LLM；
   *  - not-found    ：指定了 `doc` 但库里找不到这个 ready 文件（没索引完/被移动）；
   *  - timeout      ：LLM 排队+推理超过 MIND_LLM_TIMEOUT_MS 被掐断；
   *  - model-failed ：模型调用返回失败（provider down / 解析失败等）。 */
  reason?: 'empty' | 'not-found' | 'timeout' | 'model-failed';
  fingerprint: string;
  /**
   * **本次实际作用域**（回执）。渲染层必须校验它：请求 `doc` 却拿到别的作用域，
   * 说明这个主进程版本没实现/忽略了 `doc` 参数——此时**必须丢弃结果并提示重启**，
   * 绝不能把整库脑图当成本文档脑图展示。
   *
   * 真机事故（2026-09-16）：渲染层已更新（传 `doc`）而主进程仍是旧代码（不认识
   * `doc`，静默退回"整库前 10 个文件"），于是一份"仅本文档"的 ECS 早会转写脑图里
   * 全是 `1/`、`11/16/`、`from-tasks/` 里别的文件的内容，用户完全看不出问题出在作用域。
   */
  scope: KbMindScope;
  /** 实际纳入 prompt 的文件相对路径。`scope='doc'` 时**必须恰好 1 个且等于请求值**。 */
  files: string[];
}

export interface KbMindDeps {
  complete: (opts: {
    userId: string;
    message: string;
    systemPrompt: string;
    sessionId: string;
  }) => Promise<{ ok: boolean; text: string; error: string }>;
}

/** 保存的脑图：库 key → 根节点 + 保存时间（用户数据目录 JSON）。 */
export interface SavedMind {
  root: KbMindNode;
  savedAt: number;
}

const MIND_STORE_FILE = path.join(WS_ROOT, 'kb-mindmaps.json');

function readStore(): Record<string, SavedMind> {
  try { return JSON.parse(fs.readFileSync(MIND_STORE_FILE, 'utf8')); } catch { return {}; }
}
function writeStore(store: Record<string, SavedMind>): void {
  try { fs.mkdirSync(path.dirname(MIND_STORE_FILE), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(MIND_STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

/** 库 key：space:xxx / dir:xxx / doc:xxx（文档级脑图）。 */
export function mindKey(spaceId?: string | null, dir?: string | null, doc?: string | null): string {
  if (doc) return `doc:${doc}`;
  return spaceId ? `space:${spaceId}` : `dir:${dir || 'global'}`;
}

export function saveMindmap(key: string, root: KbMindNode): void {
  const store = readStore();
  store[key] = { root, savedAt: Date.now() };
  writeStore(store);
}

export function listMindmaps(): Array<{ key: string; savedAt: number }> {
  const store = readStore();
  return Object.keys(store)
    .map((k) => ({ key: k, savedAt: store[k].savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function loadMindmap(key: string): KbMindNode | null {
  const hit = readStore()[key];
  return hit && hit.root ? hit.root : null;
}

/** 删除一条存档（key 不存在返回 false）。会话历史删除时用于清理其脑图快照。 */
export function deleteMindmap(key: string): boolean {
  const store = readStore();
  if (!(key in store)) return false;
  delete store[key];
  writeStore(store);
  return true;
}

const MIND_SYSTEM_PROMPT = `你是知识库结构整理助手。根据提供的文档要点，输出一个层级思维导图 JSON（协议对齐 NotebookLM mind-map 的层级结构）：
{"root":{"label":"中心主题","children":[{"label":"分支1","children":[{"label":"子节点1a","children":[{"label":"叶子1a-1","children":[]}]}]}]}}
要求：
1. **必须有中心根主题**（root.label）：用一句话概括整个知识库/材料的主题，所有分支从根向外放射，严禁串成单链；
2. **必须覆盖材料的全部内容，不得只整理开头**：要点里出现的每一个一级章节/主题，都要成为一级分支，一个都不能漏、不能合并（例如要点里有「一、二、三…」或若干并列主题时，一级分支就要对应它们）；
3. 一级分支 **2–8 个**，按内容主题拆分成并列大类，不要按时间/检索顺序串行排列；同级分支彼此并行；
4. **层级展开到 3–4 层**：一级分支下 2–6 个子节点；子节点若还能拆（有具体做法、指标、清单、名词、角色），继续拆一层到两层，不要把多个要点堆在一个节点里；整个导图节点总数控制在 **120 个以内**；
5. 节点 label 用**能独立看懂的中文短语**（建议 6–24 字，允许完整短语，但不要写成整段话）；完整的标题、文件路径、来源文档等信息放到该节点的 **source** 字段；
6. 数字、指标、专业名词（如 2 万家企业、Skills、Ontology、MaaS、KSTAR）要保留在对应节点的 label 里，不要丢掉；
7. 只输出 JSON，不要任何额外文字。`;

const cache = new Map<string, KbMindResult>();

/** 同一指纹的在途生成（single-flight）。用户连点生成 / 后台预热 + 手动点击并发时，
 *  只发起一次 LLM 调用，后到者复用同一 Promise 等待真实结果——避免重复请求
 *  挤占模型队列（此前"点击两次 = 两个 45s 排队超时"的根因之一）。 */
const inflight = new Map<string, Promise<KbMindResult>>();

function fingerprint(docLines: string[]): string {
  return createHash('sha256').update(docLines.join('\u0000')).digest('hex').slice(0, 16);
}

/** 从 LLM 文本中提取层级树 JSON（容忍代码块/前后杂文）。 */
export function parseMindJson(text: string): KbMindNode {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  const data = m ? JSON.parse(m[0]) : {};
  const walk = (n: any): KbMindNode => {
    const kids = Array.isArray(n?.children) ? n.children.map(walk) : [];
    const node: KbMindNode = { label: String(n?.label ?? n?.name ?? n?.title ?? ''), children: kids };
    const src = n?.source ?? n?.from ?? n?.doc;
    if (typeof src === 'string' && src.trim()) node.source = src.trim();
    return node;
  };
  const root = walk(data?.root ?? data);
  if (!root.label) root.label = '知识库';
  return root;
}

export async function kbMindmap(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null; doc?: string | null; force?: boolean; text?: string | null },
  deps: KbMindDeps,
): Promise<KbMindResult> {
  // 优先级：显式 text（对话回答 → 脑图）> doc（单文档脑图）> dir/space（整库脑图）
  const isText = typeof opts?.text === 'string' && !!opts.text.trim();
  const doc = opts?.doc || null;
  /** 未命中留痕：这条路径不调模型、不写存档，没有日志就成了"点了没反应"。
   *  （真机 2026-09-16 排查 doc 级脑图失败时，日志里查不到任何痕迹。） */
  const onMiss = (spaceId: string | null) => ({ reason, candidates }: { reason: string; candidates: number }) =>
    log.warn('kb mindmap doc not found', {
      user_id: maskId(userId),
      doc: doc || null,
      space_id: spaceId,
      reason,
      ready_candidates: candidates,
    });
  let resolvedSpaceId = opts?.spaceId || null;
  let docs = isText
    ? []
    : collectReadyDocs(userId, {
      dir: opts?.dir || null,
      spaceId: resolvedSpaceId,
      doc,
      onMiss: onMiss(resolvedSpaceId),
    });
  // 文档级兜底：渲染层的 spaceId 可能残留（刚看过共享库就切回个人库并右键文件），
  // 于是去共享库索引里找个人库的文件 → 空。这里再按个人库找一次。
  // 注意兜底**仍然锁定这一份 doc**（不是回退成整库），所以不会重演"整库图冒充本文档图"。
  if (doc && !docs.length && resolvedSpaceId) {
    const retry = collectReadyDocs(userId, { dir: null, spaceId: null, doc, onMiss: onMiss(null) });
    if (retry.length) {
      log.info('kb mindmap doc found in personal library after space miss', {
        user_id: maskId(userId),
        doc,
        space_id: resolvedSpaceId,
      });
      docs = retry;
      resolvedSpaceId = null;
    }
  }
  const docLines = isText
    ? [opts.text!.trim().slice(0, DOC_CHAR_CAP * 8)]
    : docs.map((d) => d.text);
  const scope: KbMindScope = isText ? 'text' : doc ? 'doc' : (opts?.spaceId ? 'space' : 'dir');
  /** 作用域回执：无论成功还是降级，都必须如实带上"这次读了哪些文件"。 */
  const files = isText ? [] : docs.map((d) => d.path);
  const fp = fingerprint(docLines);

  const hit = cache.get(fp);
  if (hit && !opts?.force) return { ...hit, source: 'cached', scope, files };

  if (!docLines.length) {
    // 指定了 doc 却读不到 → 明确区分"这份文档没索引好"和"库是空的"，
    // 否则用户只会看到一句含糊的"当前知识库没有文档"。
    const reason = doc ? 'not-found' as const : 'empty' as const;
    return { root: { label: '知识库', children: [] }, source: 'degraded', reason, fingerprint: fp, scope, files };
  }

  const existing = inflight.get(fp);
  if (existing && !opts?.force) return existing;

  const attempt = runMindAttempt(userId, docLines, fp, deps, scope, files);
  inflight.set(fp, attempt);
  try {
    return await attempt;
  } finally {
    if (inflight.get(fp) === attempt) inflight.delete(fp);
  }
}

/** 发起一次真实的 LLM 脑图生成（带超时降级 + 迟到结果兜底缓存）。 */
async function runMindAttempt(
  userId: string,
  docLines: string[],
  fp: string,
  deps: KbMindDeps,
  scope: KbMindScope,
  files: string[],
): Promise<KbMindResult> {
  const startedAt = Date.now();
  const completion = deps.complete({
    userId,
    message: `请根据以下知识库文档要点生成层级思维导图：\n\n${docLines.join('\n\n')}`,
    systemPrompt: MIND_SYSTEM_PROMPT,
    sessionId: `aside-kbmind-${userId}`,
  });

  try {
    const res = await withTimeout(completion, MIND_LLM_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.error || 'model failed');
    const root = parseMindJson(res.text);
    const result: KbMindResult = { root, source: 'generated', fingerprint: fp, scope, files };
    cache.set(fp, result);
    trimCache();
    return result;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const reason = message.startsWith('LLM timeout') ? 'timeout' as const : 'model-failed' as const;
    log.warn('kb mindmap failed, degrading to single node', {
      user_id: maskId(userId),
      error: message,
      wait_ms: Date.now() - startedAt,
    });
    // 迟到结果兜底缓存：仅在超时降级时挂接——底层请求仍在跑，若最终成功就把结果
    // 写入缓存；用户随即重试（同指纹）即可命中秒出，而不是再等一次完整 LLM。
    if (reason === 'timeout') {
      completion.then((res) => {
        if (!res?.ok || !res.text) return;
        try {
          const late = parseMindJson(res.text);
          if (late && late.label) {
            cache.set(fp, { root: late, source: 'generated', fingerprint: fp, scope, files });
            log.info('kb mindmap late result cached (arrived after timeout)', {
              user_id: maskId(userId),
              wait_ms: Date.now() - startedAt,
            });
          }
        } catch { /* 迟到的文本解析失败不影响已返回的降级结果 */ }
      }).catch(() => { /* 底层请求失败已由降级路径覆盖 */ });
    }
    return { root: { label: '知识库', children: [] }, source: 'degraded', reason, fingerprint: fp, scope, files };
  }
}

function trimCache(): void {
  if (cache.size <= CACHE_MAX) return;
  const first = cache.keys().next().value;
  if (first) cache.delete(first);
}

export const _internals = {
  parseMindJson,
  fingerprint,
  clearCacheForTests: () => {
    cache.clear();
    inflight.clear();
  },
};

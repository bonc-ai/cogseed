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
import { collectReadyDocLines } from './kb_summary';

const log = createLogger('kb-mindmap');
const CACHE_MAX = 50;
/** 基于对话文本生成时的输入截断（防止超长回答撑爆 LLM 上下文） */
const DOC_CHAR_CAP = 4000;
/** LLM 单次脑图生成超时（网络不可达/模型卡住时降级为单节点，避免 UI 无限等待） */
const MIND_LLM_TIMEOUT_MS = 45 * 1000;

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

export interface KbMindResult {
  root: KbMindNode;
  source: 'generated' | 'cached' | 'degraded';
  fingerprint: string;
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

/** 库 key：space:xxx / dir:xxx。 */
export function mindKey(spaceId?: string | null, dir?: string | null): string {
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

const MIND_SYSTEM_PROMPT = `你是知识库结构整理助手。根据提供的文档要点，输出一个层级思维导图 JSON（协议对齐 NotebookLM mind-map 的层级结构）：
{"root":{"label":"中心主题","children":[{"label":"分支1","children":[{"label":"子节点1a","children":[]},{"label":"子节点1b","children":[]}]},{"label":"分支2","children":[{"label":"子节点2a","children":[]}]}]}}
要求：
1. **必须有中心根主题**（root.label）：用一句话概括整个知识库/材料的总目标（如「英语演讲课程 China Bloom 资料梳理」），所有分支从根向外放射，严禁串成单链；
2. 一级分支 **2–4 个**，按内容主题拆分成并列大类（如「模型相关资料查询」「英语演讲课程素材」），不要按时间/检索顺序串行排列；同级分支彼此并行；
3. 每个一级分支下 2–4 个子节点，可再拆一层；避免单条分支无限堆砌（深度 2–3 层封顶）；
4. 节点 label 用**简短短语**（≤12 字为宜），不要放完整长句/长标题；完整标题、文件路径、来源文档等信息放到该节点的 **source** 字段（如 "演讲稿：China Blooms in the Garden of Civilizations（来源：英语演讲/演讲稿.docx）"）；
5. 只输出 JSON，不要任何额外文字。`;

const cache = new Map<string, KbMindResult>();

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
  opts: { dir?: string | null; spaceId?: string | null; force?: boolean; text?: string | null },
  deps: KbMindDeps,
): Promise<KbMindResult> {
  // 提供 text 时基于该文本生成（对话回答 → 脑图）；否则基于知识库文档要点
  const docLines = typeof opts?.text === 'string' && opts.text.trim()
    ? [opts.text.trim().slice(0, DOC_CHAR_CAP * 8)]
    : collectReadyDocLines(userId, { dir: opts?.dir || null, spaceId: opts?.spaceId || null });
  const fp = fingerprint(docLines);

  const hit = cache.get(fp);
  if (hit && !opts?.force) return { ...hit, source: 'cached' };

  if (!docLines.length) {
    return { root: { label: '知识库', children: [] }, source: 'degraded', fingerprint: fp };
  }

  try {
    const res = await withTimeout(deps.complete({
      userId,
      message: `请根据以下知识库文档要点生成层级思维导图：\n\n${docLines.join('\n\n')}`,
      systemPrompt: MIND_SYSTEM_PROMPT,
      sessionId: `aside-kbmind-${userId}`,
    }), MIND_LLM_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.error || 'model failed');
    const root = parseMindJson(res.text);
    const result: KbMindResult = { root, source: 'generated', fingerprint: fp };
    cache.set(fp, result);
    if (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return result;
  } catch (err) {
    log.warn('kb mindmap failed, degrading to single node', {
      user_id: maskId(userId),
      error: (err as Error).message,
    });
    return { root: { label: '知识库', children: [] }, source: 'degraded', fingerprint: fp };
  }
}

export const _internals = { parseMindJson, fingerprint, clearCacheForTests: () => cache.clear() };

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
1. 2–3 层；每条分支控制深度，避免单条分支无限堆砌；
2. 每个节点含 label、children 两个字段，可选 source（该节点内容主要来源的文档文件名，如 "AST-Surgery.pdf"）；一级分支尽量给 source；
3. 只输出 JSON，不要任何额外文字。`;

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
  opts: { dir?: string | null; spaceId?: string | null; force?: boolean },
  deps: KbMindDeps,
): Promise<KbMindResult> {
  const docLines = collectReadyDocLines(userId, { dir: opts?.dir || null, spaceId: opts?.spaceId || null });
  const fp = fingerprint(docLines);

  const hit = cache.get(fp);
  if (hit && !opts?.force) return { ...hit, source: 'cached' };

  if (!docLines.length) {
    return { root: { label: '知识库', children: [] }, source: 'degraded', fingerprint: fp };
  }

  try {
    const res = await deps.complete({
      userId,
      message: `请根据以下知识库文档要点生成层级思维导图：\n\n${docLines.join('\n\n')}`,
      systemPrompt: MIND_SYSTEM_PROMPT,
      sessionId: `aside-kbmind-${userId}`,
    });
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

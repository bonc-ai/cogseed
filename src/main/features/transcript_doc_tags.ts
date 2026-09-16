/**
 * transcript_doc_tags — 转写文档的「场景标签」（接受范围里「仅本场景」的依据）
 *
 * 为什么需要这一层：词条作用域支持 `{ scenarioTags, global: false }`（只在本场景生效），
 * 生效判定在 `transcript_glossary.scopeAllows()`。但**标签此前没有任何来源**：
 *   - 面板的 `ctx.scenarioTags` 只来自挂载入参，而唯一挂载点（anchored-source-view）
 *     只传 text/docId/displayPath → 恒为空数组 → 「仅本场景」永远置灰；
 *   - 即使词条已带标签（唯一来源是贡献包导入），扫描时也不传"目标文档的标签"
 *     → `scopeAllows()` 恒 false → 一律判 out_of_scope，永不命中。
 * 也就是这条链路两头都断。这里补上「文档 → 场景标签」这一环。
 *
 * 标签从哪来（不自造语义）：
 *   1. **用户为该文档确认/命名的场景**（本模块存储，面板里可增删）；
 *   2. **建议值**来自个人本体的分组分节（设计来源，见《本体×转写纠错-P1最小接线方案》：
 *      「概念名 + 所属分节/字段 → 可作 ontologyRef 与场景标签」）。本机没有分组时
 *      就是空建议，不做猜测——宁可让用户自己命名，也不拿目录名冒充场景。
 *
 * 存储与词表同域（cloud，账号体系落地后可同步）：`transcript/transcript-doc-tags.json`。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger';
import { userTranscriptDocTagsFile } from '../paths';

const log = createLogger('transcript-doc-tags');

/** 单文档标签上限（够表达"哪门课/哪个项目"，又不至于变成垃圾场）。 */
const MAX_TAGS_PER_DOC = 8;
/** 单个标签长度上限（码点计，中文 24 字 ≈ 一句话的主题）。 */
const MAX_TAG_CHARS = 24;
/** 建议值条数上限。 */
const MAX_SUGGESTIONS = 12;

export interface DocTagsFile {
  version: 1;
  docs: Record<string, { tags: string[]; updatedAt: number }>;
}

function emptyFile(): DocTagsFile {
  return { version: 1, docs: {} };
}

/** 读档：损坏/缺字段一律降级为空（不因为一份标签文件把面板拖挂）。 */
export function loadDocTags(uid: string): DocTagsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(userTranscriptDocTagsFile(uid), 'utf8')) as Partial<DocTagsFile>;
    const docs: DocTagsFile['docs'] = {};
    for (const [docId, value] of Object.entries(raw?.docs ?? {})) {
      const tags = normalizeTags((value as { tags?: unknown })?.tags);
      if (!docId || !tags.length) continue;
      docs[docId] = { tags, updatedAt: Number((value as { updatedAt?: unknown })?.updatedAt) || 0 };
    }
    return { version: 1, docs };
  } catch {
    return emptyFile();
  }
}

function saveDocTags(uid: string, file: DocTagsFile): void {
  const abs = userTranscriptDocTagsFile(uid);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(file, null, 2), 'utf8');
}

/**
 * 标签归一：NFKC + 去首尾空白 + 折叠内部空白、去重（大小写不敏感，保留先出现的写法）、
 * 按上限截断。**不做同义词合并**——那是本体该管的事，这里不越权。
 */
export function normalizeTags(input: unknown): string[] {
  const list = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let tag = String(item ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    tag = Array.from(tag).slice(0, MAX_TAG_CHARS).join('').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_DOC) break;
  }
  return out;
}

/** 该文档当前的场景标签（无 → 空数组）。 */
export function readTagsForDoc(uid: string, docId: string): string[] {
  const id = String(docId ?? '').trim();
  if (!id) return [];
  return loadDocTags(uid).docs[id]?.tags ?? [];
}

/** 写入该文档的场景标签；空数组 = 清除（该文档回到"未标注场景"）。 */
export function setTagsForDoc(
  uid: string,
  docId: string,
  tags: unknown,
): { ok: true; tags: string[] } | { ok: false; error: string } {
  const id = String(docId ?? '').trim();
  if (!id) return { ok: false, error: 'missing docId' };
  if (id.length > 200) return { ok: false, error: 'docId too long' };
  const next = normalizeTags(tags);
  const file = loadDocTags(uid);
  if (next.length) file.docs[id] = { tags: next, updatedAt: Date.now() };
  else delete file.docs[id];
  try {
    saveDocTags(uid, file);
  } catch (err) {
    log.warn('doc tags save failed', { error: (err as Error).message });
    return { ok: false, error: 'save failed' };
  }
  return { ok: true, tags: next };
}

/**
 * 场景标签建议：个人本体分组的分节 / 字段名（设计指定的来源）。
 * 只读、best-effort——本体读不出来（无分组 / 文件坏了 / 未登录）就返回空数组，
 * 绝不让"建议"把面板挂掉。
 */
export async function suggestScenarioTags(uid: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const groups = await import('./personal_ontology_groups');
    const metas = groups.readGroups(uid) ?? [];
    for (const meta of metas) {
      // 分组标题本身就是一句"这是什么场景/主题"的命名，直接可用
      if (meta?.title) out.push(String(meta.title));
      if (out.length >= MAX_SUGGESTIONS) break;
      const res = await groups.listGroupFields(uid, meta.group_id);
      for (const field of res?.fields ?? []) {
        if (field?.sectionTitle) out.push(String(field.sectionTitle));
        if (out.length >= MAX_SUGGESTIONS) break;
      }
      if (out.length >= MAX_SUGGESTIONS) break;
    }
  } catch (err) {
    log.warn('scenario tag suggestions unavailable', { error: (err as Error).message });
  }
  return normalizeTags(out);
}

export const _internals = {
  normalizeTags,
  MAX_TAGS_PER_DOC,
  MAX_TAG_CHARS,
};

/**
 * 飞书分享模块（方案 A/B）：把 CogSeed 空间/知识库导出为飞书 wiki/docx 公网链接。
 *
 * ⚠️ 与 `personal_context/feishu/api-client.ts`（只读同步）严格隔离：
 * 本模块是独立写入端点（创建 docx/wiki、写 blocks、传附件、改权限），
 * 不修改只读 client，避免破坏"任何写入端点不得出现在只读模块"的架构约束。
 *
 * 设计（对齐方案 B 文档）：
 * - 分享对象：飞书 wiki 知识空间（首页 = 空间名 + 总览，文件树 → 子节点 docx）；
 * - 权限三档：anyone（互联网可读）/ tenant（组织内可读）/ private（关闭链接）；
 * - 状态持久化：`<uid>/local/config/personal-context/feishu-shares.json`，
 *   记录每个 spaceId 的分享链接/节点/哈希，支持更新（重推）与撤销。
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso } from '../../storage';
import { userLocalConfigDir } from '../../paths';
import * as spaceLibrary from '../project_library_indexer';
import { getFeishuShareCredential } from '../personal_context/manager';
import { hasFeishuShareScopes } from '../personal_context/feishu/oauth';

const log = createLogger('share:feishu');

const FEISHU_OPEN_BASE = 'https://open.feishu.cn';
const STATE_VERSION = 1;
const MAX_DOCS_PER_SHARE = 50;      // 单次分享文件数上限（护栏，防超限）
const MAX_MD_BYTES_PER_DOC = 200 * 1024; // 单文档正文上限（飞书单块/文档容量护栏）

// ── 类型 ───────────────────────────────────────────────────────────────────
export type FeishuShareAccess = 'anyone' | 'tenant' | 'private';

export interface FeishuShareState {
  spaceId: string;
  spaceName: string;
  url: string;
  wikiSpaceId: string;
  wikiNodeToken: string;
  wikiNodeObjToken: string;
  access: FeishuShareAccess;
  contentHash: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
  /** 飞书租户域名（如 bonc.feishu.cn），拼链接用；缺省用 open.feishu.cn 占位 */
  tenantDomain?: string;
}

export type ShareResult =
  | { ok: true; state: FeishuShareState }
  | { ok: false; code: ShareErrorCode; error: string };

export interface FeishuShareClient {
  createWikiSpace(name: string, description: string): Promise<{ space_id: string }>;
  createWikiNode(spaceId: string, title: string, parentNodeToken?: string): Promise<{ node_token: string; obj_token: string }>;
  createDocx(title: string): Promise<{ document_id: string }>;
  appendChildren(documentId: string, blockId: string, children: DocxBlock[]): Promise<void>;
  getRootBlockId(documentId: string): Promise<string>;
  setPublicAccess(token: string, type: 'wiki' | 'docx', access: FeishuShareAccess): Promise<void>;
  getDocUrl(token: string, type: 'wiki' | 'docx'): Promise<string>;
  deleteWikiSpace(spaceId: string): Promise<void>;
}

/** 飞书 docx block（新版文档 v1）：字段名与 block_type 一一对应 */
export interface DocxBlock {
  block_type: number;
  text?: { elements: TextElement[] };
  heading1?: { elements: TextElement[] };
  heading2?: { elements: TextElement[] };
  heading3?: { elements: TextElement[] };
  heading4?: { elements: TextElement[] };
  heading5?: { elements: TextElement[] };
  heading6?: { elements: TextElement[] };
  bullet?: { elements: TextElement[] };
  ordered?: { elements: TextElement[] };
  code?: { elements: TextElement[] };
  quote?: { elements: TextElement[] };
}
export interface TextElement {
  text_run: { content: string; text_element_style?: Record<string, unknown> };
}

// ── HTTP 实现 ──────────────────────────────────────────────────────────────
export interface HttpFeishuShareClientOptions {
  accessToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 真实租户域名（如 bonc.feishu.cn）；缺省用 open.feishu.cn */
  tenantDomain?: string;
}

export class HttpFeishuShareClient implements FeishuShareClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tenantDomain: string;

  constructor(opts: HttpFeishuShareClientOptions) {
    this.accessToken = opts.accessToken;
    this.baseUrl = (opts.baseUrl ?? FEISHU_OPEN_BASE).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tenantDomain = opts.tenantDomain ?? 'open.feishu.cn';
  }

  private async request<T>(method: string, p: string, opts: { body?: unknown; isForm?: boolean } = {}): Promise<T> {
    const url = new URL(this.baseUrl + p);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    let body: string | FormData | undefined;
    if (opts.isForm && opts.body instanceof FormData) {
      body = opts.body; // fetch 自动带 multipart boundary
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(opts.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, body: body as BodyInit | undefined });
    } catch (err) {
      throw new Error(`feishu share network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text();
    let parsed: { code?: unknown; msg?: unknown; data?: unknown } = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!response.ok || (typeof parsed.code === 'number' && parsed.code !== 0)) {
      // 企业禁止组织外分享：飞书 129003/1111/22400 等权限码 → 映射为 enterprise_share_disabled
      const code = typeof parsed.code === 'number' ? parsed.code : response.status;
      const msg = typeof parsed.msg === 'string' ? parsed.msg : `http ${response.status}`;
      if (isEnterpriseShareBlocked(code, msg)) {
        throw new ShareError('enterprise_share_disabled', `飞书组织外分享被企业设置禁止：${msg}（请管理员在飞书管理后台开启『允许文档分享到组织外』）`);
      }
      throw new ShareError('share_failed', `feishu share api ${code}: ${msg} (${method} ${p})${body ? ` | body=${String(body).slice(0, 400)}` : ''}`);
    }
    return parsed as T;
  }

  async createWikiSpace(name: string, description: string): Promise<{ space_id: string }> {
    // 请求体只含 name/description（user_id_type 不属于本接口，传了会 99992402）
    const body = await this.request<{ data: { space?: { space_id?: string } } }>('POST', '/open-apis/wiki/v2/spaces', {
      body: { name, description },
    });
    const spaceId = body.data?.space?.space_id;
    if (!spaceId) throw new ShareError('share_failed', '创建飞书知识空间失败：响应缺少 space_id');
    return { space_id: spaceId };
  }

  async createWikiNode(spaceId: string, title: string, parentNodeToken?: string): Promise<{ node_token: string; obj_token: string }> {
    // 必须带 node_type:"origin"（实体节点）；user_id_type 不属于本接口
    const body = await this.request<{ data: { node?: { node_token?: string; obj_token?: string } } }>(
      'POST',
      `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`,
      { body: { obj_type: 'docx', node_type: 'origin', parent_node_token: parentNodeToken ?? '', title } },
    );
    const node = body.data?.node;
    if (!node?.node_token || !node.obj_token) throw new ShareError('share_failed', '创建飞书知识节点失败：响应缺少 token');
    return { node_token: node.node_token, obj_token: node.obj_token };
  }

  async createDocx(title: string): Promise<{ document_id: string }> {
    const body = await this.request<{ data: { document?: { document_id?: string } } }>('POST', '/open-apis/docx/v1/documents', {
      body: { title },
    });
    const documentId = body.data?.document?.document_id;
    if (!documentId) throw new ShareError('share_failed', '创建飞书文档失败：响应缺少 document_id');
    return { document_id: documentId };
  }

  /** 读取文档根块 id（新版 docx 根块 block_type=1/page） */
  async getRootBlockId(documentId: string): Promise<string> {
    const body = await this.request<{ data?: { items?: Array<{ block_id?: string; block_type?: number }> } }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=10`,
    );
    log.info('docx blocks list', { documentId, count: (body.data?.items ?? []).length, types: (body.data?.items ?? []).map((i) => i.block_type).slice(0, 5) });
    const root = (body.data?.items ?? []).find((item) => item.block_type === 1);
    if (root?.block_id) return root.block_id;
    // 兼容：根块缺省即 document_id
    return documentId;
  }

  async appendChildren(documentId: string, blockId: string, children: DocxBlock[]): Promise<void> {
    // 分批写入（单次请求块数限制，避免超大分享失败）。
    // 不传 index：飞书默认追加到末尾（传 -1 触发 1770001 invalid param）。
    const CHUNK = 50;
    for (let i = 0; i < children.length; i += CHUNK) {
      const slice = children.slice(i, i + CHUNK);
      await this.request(
        'POST',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}/children`,
        { body: { children: slice } },
      );
    }
  }

  async setPublicAccess(token: string, type: 'wiki' | 'docx', access: FeishuShareAccess): Promise<void> {
    // 新版 permission-public API（v2）：external_access 为 boolean，link_share_entity 三档。
    // ⚠️ type=wiki 不支持组织外分享（external_access/link_share_entity 均被拒）；
    //    组织外分享必须用 type=docx（对 docx 实体设权限，wiki 链接仍可访问）。
    const map = {
      anyone: { external_access: true, link_share_entity: 'anyone_readable' },
      tenant: { external_access: false, link_share_entity: 'tenant_readable' },
      private: { external_access: false, link_share_entity: 'closed' },
    } as const;
    const body = map[access];
    await this.request(
      'PATCH',
      `/open-apis/drive/v2/permissions/${encodeURIComponent(token)}/public?type=${type}`,
      { body },
    );
  }

  /** 通过 metas/batch_query 拿文档公开链接（含租户域名）；失败降级为拼接 URL */
  async getDocUrl(token: string, type: 'wiki' | 'docx'): Promise<string> {
    try {
      const body = await this.request<{ data?: { metas?: Array<{ url?: string }> } }>(
        'POST',
        '/open-apis/drive/v1/metas/batch_query',
        { body: { request_docs: [{ doc_token: token, doc_type: type }] } },
      );
      const url = body.data?.metas?.[0]?.url;
      if (url) return url;
    } catch (err) {
      // metas 需要 drive:drive 权限，缺权限时降级为拼接 URL（不影响分享主链路）
      log.warn('metas batch_query failed, fallback to assembled url', { token, error: err instanceof Error ? err.message : String(err) });
    }
    // 兜底：拼接租户域名（metas 不可用时仍可访问；open.feishu.cn 打开后会自动跳转）
    const pathSegment = type === 'wiki' ? 'wiki' : 'docx';
    return `https://${this.tenantDomain}/${pathSegment}/${token}`;
  }

  async deleteWikiSpace(spaceId: string): Promise<void> {
    await this.request('DELETE', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}`);
  }
}

export type ShareErrorCode = 'not_configured' | 'not_authorized' | 'need_reauthorize' | 'enterprise_share_disabled' | 'share_failed';

export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode, message: string) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
  }
}

function isEnterpriseShareBlocked(code: number | string, msg: string): boolean {
  const blocked = new Set([129003, 1111, 22400, 22201, 31001]);
  if (typeof code === 'number' && blocked.has(code)) return true;
  return /组织外|外部分享|对外分享|分享.*禁止|不允许.*分享/i.test(msg);
}

// ── Markdown → docx blocks（纯函数，可单测）──────────────────────────────
// 新版 docx API block_type（对齐官方 SDK type_docx.go）：
// 1=page 2=text 3..11=heading1..9 12=bullet 13=ordered 14=code 15=quote
// ⚠️ 字段名必须与 block_type 一一对应：heading1 块的字段叫 heading1，
//    text 块叫 text，bullet 块叫 bullet……（不是统一 text 字段）。
const BLOCK = {
  text: 2, h1: 3, h2: 4, h3: 5, h4: 6, h5: 7, h6: 8, h7: 9, h8: 10, h9: 11,
  bullet: 12, ordered: 13, code: 14, quote: 15,
} as const;

function textElement(content: string): TextElement {
  return { text_run: { content } };
}

function block(type: number, field: string, content: string): DocxBlock {
  return { block_type: type, [field]: { elements: [textElement(content)] } } as DocxBlock;
}

/** 单行 → block；支持 # 标题 / - 无序 / 1. 有序 / ` 代码 / > 引用 / 普通段落 */
export function markdownLineToBlock(line: string): DocxBlock | null {
  const t = line.trimEnd();
  if (!t.trim()) return null;
  const text = t.replace(/\s+$/, '');
  const h = /^(#{1,6})\s+(.*)$/.exec(text);
  if (h) {
    const level = Math.min(h[1].length, 9);
    const field = `heading${level}` as 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6';
    const type = BLOCK[`h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'];
    return block(type, field, h[2].trim());
  }
  if (/^-\s+/.test(text) || /^\*\s+/.test(text)) {
    return block(BLOCK.bullet, 'bullet', text.replace(/^[-*]\s+/, ''));
  }
  if (/^\d+[.)]\s+/.test(text)) {
    return block(BLOCK.ordered, 'ordered', text.replace(/^\d+[.)]\s+/, ''));
  }
  if (/^```/.test(text)) {
    return block(BLOCK.code, 'code', text.replace(/^```+/, ''));
  }
  if (/^>\s?/.test(text)) {
    return block(BLOCK.quote, 'quote', text.replace(/^>\s?/, ''));
  }
  return block(BLOCK.text, 'text', text);
}

/** Markdown 全文 → docx blocks（按行转换；代码块内多行合并为单 code block） */
export function markdownToDocxBlocks(md: string): DocxBlock[] {
  const lines = (md ?? '').split(/\r?\n/);
  const out: DocxBlock[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  const flushCode = () => {
    if (!inCode) return;
    out.push(block(BLOCK.code, 'code', codeBuf.join('\n')));
    codeBuf = [];
    inCode = false;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const isFence = /^```/.test(line.trim());
    if (isFence) {
      if (inCode) flushCode();
      else { inCode = true; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const b = markdownLineToBlock(line);
    if (b) out.push(b);
  }
  flushCode();
  return out;
}

// ── 状态持久化 ─────────────────────────────────────────────────────────────
interface ShareStateFile {
  version: number;
  updatedAt: string;
  items: FeishuShareState[];
}

function stateFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'personal-context', 'feishu-shares.json');
}

async function readStates(uid: string): Promise<FeishuShareState[]> {
  try {
    const raw = await readJson<Partial<ShareStateFile>>(stateFile(uid));
    return Array.isArray(raw.items) ? raw.items.filter(isValidState) : [];
  } catch {
    return [];
  }
}

async function writeStates(uid: string, items: FeishuShareState[]): Promise<void> {
  const file = stateFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeJson(file, { version: STATE_VERSION, updatedAt: nowIso(), items } satisfies ShareStateFile);
}

function isValidState(value: unknown): value is FeishuShareState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.spaceId === 'string' && typeof s.url === 'string' && typeof s.wikiSpaceId === 'string';
}

// ── 内容收集 ───────────────────────────────────────────────────────────────
/** 从空间库收集 ready 文件的 Markdown（标题 + 分块正文），供渲染到飞书文档 */
export function collectSpaceMarkdown(uid: string, spaceId: string, opts: { maxDocs?: number } = {}): { md: string; count: number } {
  const maxDocs = opts.maxDocs ?? MAX_DOCS_PER_SHARE;
  const files = spaceLibrary
    .listFiles(uid, spaceId)
    .filter((f) => f.status === 'ready')
    .slice(0, maxDocs);
  const parts: string[] = [];
  for (const f of files) {
    const chunks = spaceLibrary.readFileChunks(uid, spaceId, f.rel_path);
    const head = (chunks || []).slice(0, 8)
      .map((c) => (c.title ? `### ${c.title}\n\n${c.content ?? ''}` : `${c.content ?? ''}`))
      .join('\n\n');
    if (!head.trim()) continue;
    parts.push(`## ${f.rel_path}\n\n${head}`);
  }
  const md = parts.join('\n\n---\n\n').slice(0, MAX_MD_BYTES_PER_DOC);
  return { md, count: files.length };
}

// ── 分享主流程 ─────────────────────────────────────────────────────────────
export interface PushSpaceOptions {
  access?: FeishuShareAccess;
  /** 覆盖已存在分享（默认：若已分享则先撤销旧空间再重建） */
  force?: boolean;
}

/** 把空间分享到飞书 wiki（方案 B 链路：空间 → 首页总览 + 文件内容 → 权限） */
export async function pushSpaceToFeishu(uid: string, spaceId: string, opts: PushSpaceOptions = {}): Promise<ShareResult> {
  const access = opts.access ?? 'anyone';
  const credential = await getFeishuShareCredential(uid);
  if (!credential) return { ok: false, code: 'not_configured', error: '尚未配置飞书应用：请点击「配置飞书」填写应用凭据并完成授权' };
  if (!hasFeishuShareScopes(credential.scopes)) {
    return { ok: false, code: 'need_reauthorize', error: '分享需要飞书写权限，请重新授权（将跳转飞书授权页）' };
  }

  const existing = (await readStates(uid)).find((s) => s.spaceId === spaceId);
  if (existing && !opts.force) {
    return { ok: true, state: existing };
  }
  if (existing && opts.force) {
    await _revokeState(uid, existing, 'delete_space').catch(() => { /* 重建前旧空间删除失败不阻塞 */ });
  }

  try {
    const client = new HttpFeishuShareClient({
      accessToken: credential.accessToken,
      tenantDomain: credential.tenantDomain,
    });
    const { md, count } = collectSpaceMarkdown(uid, spaceId);
    const spaceMeta = await _readSpaceMeta(uid, spaceId);
    const spaceName = spaceMeta?.name || spaceId;

    // 1. 创建独立 docx（方案 A 链路）——wiki 节点不支持组织外分享
    //    （type=wiki 时 external_access/link_share_entity 均被拒），
    //    独立 docx 才支持 anyone_readable 公网链接。
    const doc = await client.createDocx(spaceName);

    // 2. 写入总览 + 文件正文
    const overview = `# ${spaceName}\n\n${md}`;
    const rootBlockId = await client.getRootBlockId(doc.document_id);
    const blocks = markdownToDocxBlocks(overview);
    await client.appendChildren(doc.document_id, rootBlockId, blocks);

    // 3. 权限三档（type=docx）
    await client.setPublicAccess(doc.document_id, 'docx', access);

    // 4. 链接
    const url = await client.getDocUrl(doc.document_id, 'docx');
    const contentHash = crypto.createHash('sha256').update(md).digest('hex');
    const state: FeishuShareState = {
      spaceId,
      spaceName,
      url,
      wikiSpaceId: '',
      wikiNodeToken: '',
      wikiNodeObjToken: doc.document_id,
      access,
      contentHash,
      fileCount: count,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      tenantDomain: credential.tenantDomain,
    };
    const items = (await readStates(uid)).filter((s) => s.spaceId !== spaceId);
    items.push(state);
    await writeStates(uid, items);
    log.info('feishu share pushed', { spaceId, url: state.url, files: count });
    return { ok: true, state };
  } catch (err) {
    const shareErr = err instanceof ShareError ? err : null;
    const code = shareErr?.code ?? 'share_failed';
    const message = err instanceof Error ? err.message : String(err);
    log.warn('feishu share push failed', { spaceId, code, error: message });
    return { ok: false, code, error: message };
  }
}

/** 内容更新检测：md 哈希变化 → 需要重推；无变化返回 null */
export async function shareNeedsUpdate(uid: string, spaceId: string): Promise<{ needed: boolean; current?: FeishuShareState }> {
  const existing = (await readStates(uid)).find((s) => s.spaceId === spaceId);
  if (!existing) return { needed: true };
  const { md } = collectSpaceMarkdown(uid, spaceId);
  const hash = crypto.createHash('sha256').update(md).digest('hex');
  return { needed: existing.contentHash !== hash, current: existing };
}

export async function listFeishuShares(uid: string): Promise<FeishuShareState[]> {
  return readStates(uid);
}

export async function getFeishuShare(uid: string, spaceId: string): Promise<FeishuShareState | null> {
  return (await readStates(uid)).find((s) => s.spaceId === spaceId) ?? null;
}

export type RevokeMode = 'close_link' | 'delete_space';

export async function revokeFeishuShare(uid: string, spaceId: string, mode: RevokeMode = 'close_link'): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = (await readStates(uid)).find((s) => s.spaceId === spaceId);
  if (!state) return { ok: true }; // 无分享记录：幂等成功
  try {
    await _revokeState(uid, state, mode);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('feishu share revoke failed', { spaceId, mode, error: message });
    return { ok: false, error: message };
  }
}

async function _revokeState(uid: string, state: FeishuShareState, mode: RevokeMode): Promise<void> {
  const credential = await getFeishuShareCredential(uid);
  if (credential) {
    const client = new HttpFeishuShareClient({ accessToken: credential.accessToken });
    // 独立 docx 分享：两种撤销模式均关闭链接（外部不可读）。docx 无删除 API，
    // "删除云端副本"对 docx 语义等同"关闭链接"（外部不可访问）。
    const token = state.wikiNodeObjToken || state.wikiNodeToken;
    if (token) {
      await client.setPublicAccess(token, 'docx', 'private');
    }
  }
  const items = (await readStates(uid)).filter((s) => s.spaceId !== state.spaceId);
  await writeStates(uid, items);
}

async function _readSpaceMeta(uid: string, spaceId: string): Promise<{ name?: string; description?: string } | null> {
  try {
    const { spaceMetaFile } = await import('../../paths');
    const raw = await readJson<{ name?: string; description?: string }>(spaceMetaFile(uid, spaceId));
    return raw ?? null;
  } catch {
    return null;
  }
}

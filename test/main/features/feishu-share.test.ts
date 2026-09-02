import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 分享模块（feishu-share.ts）不依赖 Electron，直接测纯逻辑 + mock client。
// 覆盖：markdown→blocks 转换、状态持久化、push/revoke 编排、错误映射。
// WS_ROOT 由 vitest setup-env.ts 冻结到临时目录；状态文件路径经
// userLocalConfigDir(uid) 解析，beforeEach 用同一路径清理保证用例隔离。
import {
  markdownLineToBlock,
  markdownToDocxBlocks,
  pushSpaceToFeishu,
  revokeFeishuShare,
  listFeishuShares,
  shareNeedsUpdate,
  ShareError,
  HttpFeishuShareClient,
  type FeishuShareClient,
} from '../../../src/main/features/share/feishu-share';
import { userLocalConfigDir } from '../../../src/main/paths';

const UID = 'tester-001';

function shareStateFile(): string {
  return path.join(userLocalConfigDir(UID), 'personal-context', 'feishu-shares.json');
}

function clearShareState(): void {
  try { fs.rmSync(shareStateFile(), { force: true }); } catch { /* noop */ }
}

// mock manager 凭据获取 + space 库（share 模块 import 的依赖）
vi.mock('../../../src/main/features/personal_context/manager', () => ({
  getFeishuShareCredential: vi.fn(async () => ({
    accessToken: 'uat_CHANGEME_mock_token',
    scopes: ['docx:document', 'wiki:wiki', 'drive:file', 'docs:permission.setting:write_only'],
    tenantKey: 'mock-tenant',
    unionId: 'mock-union',
    tenantDomain: 'mock.feishu.cn',
  })),
}));

vi.mock('../../../src/main/features/project_library_indexer', () => ({
  listFiles: vi.fn(() => [
    { rel_path: 'README.md', status: 'ready', sha1: 'a', bytes: 10 },
    { rel_path: 'docs/guide.md', status: 'ready', sha1: 'b', bytes: 10 },
  ]),
  readFileChunks: vi.fn((_uid, _spaceId, relPath) => {
    if (relPath === 'README.md') return [{ chunk_idx: 0, title: 'README', content: '# CogSeed\n\n知识库正文。' }];
    return [{ chunk_idx: 0, title: 'Guide', content: '使用说明。' }];
  }),
}));

// ── mock FeishuShareClient ────────────────────────────────────────────────
class MockShareClient implements FeishuShareClient {
  calls: string[] = [];
  private urls = new Map<string, string>();
  deleted: string[] = [];
  access: Record<string, unknown> = {};

  async createWikiSpace(name: string, _desc: string) {
    this.calls.push(`createWikiSpace:${name}`);
    return { space_id: 'wiki-space-1' };
  }
  async createWikiNode(spaceId: string, title: string, _parent?: string) {
    this.calls.push(`createWikiNode:${spaceId}:${title}`);
    return { node_token: 'node-1', obj_token: 'doc-1' };
  }
  async createDocx(title: string) {
    this.calls.push(`createDocx:${title}`);
    return { document_id: 'doc-1' };
  }
  async getRootBlockId(documentId: string) {
    this.calls.push(`getRootBlockId:${documentId}`);
    return 'root-1';
  }
  async appendChildren(documentId: string, blockId: string, children: unknown[]) {
    this.calls.push(`appendChildren:${documentId}:${blockId}:${children.length}`);
  }
  async setPublicAccess(token: string, type: string, access: string) {
    this.calls.push(`setPublicAccess:${token}:${type}:${access}`);
    this.access[token] = access;
  }
  async getDocUrl(token: string, type: string) {
    const key = `${type}:${token}`;
    if (!this.urls.has(key)) this.urls.set(key, `https://mock.feishu.cn/${type}/${token}`);
    return this.urls.get(key) as string;
  }
  async deleteWikiSpace(spaceId: string) {
    this.calls.push(`deleteWikiSpace:${spaceId}`);
    this.deleted.push(spaceId);
  }
}

// ── Markdown → blocks ─────────────────────────────────────────────────────
describe('feishu-share › markdownLineToBlock', () => {
  it('标题映射到 heading1/2/3', () => {
    expect(markdownLineToBlock('# 一级')?.block_type).toBe(3);
    expect(markdownLineToBlock('## 二级')?.block_type).toBe(4);
    expect(markdownLineToBlock('### 三级')?.block_type).toBe(5);
  });
  it('无序/有序列表、引用、段落', () => {
    expect(markdownLineToBlock('- 条目')?.block_type).toBe(12);
    expect(markdownLineToBlock('1. 步骤')?.block_type).toBe(13);
    expect(markdownLineToBlock('> 引用')?.block_type).toBe(15);
    expect(markdownLineToBlock('普通段落文本')?.block_type).toBe(2);
  });
  it('空行返回 null（不生成空块）', () => {
    expect(markdownLineToBlock('   ')).toBeNull();
    expect(markdownLineToBlock('')).toBeNull();
  });
});

describe('feishu-share › markdownToDocxBlocks', () => {
  it('按行转换并保留标题', () => {
    const blocks = markdownToDocxBlocks('# 标题\n\n正文第一段\n- 甲\n- 乙');
    expect(blocks.length).toBe(4);
    expect(blocks[0].block_type).toBe(3);
    expect(blocks[1].block_type).toBe(2);
    expect(blocks[2].block_type).toBe(12);
    expect(blocks[3].block_type).toBe(12);
  });
  it('代码块合并为单个 code block', () => {
    const blocks = markdownToDocxBlocks('```js\nconst a = 1;\nconst b = 2;\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].block_type).toBe(14);
  });
  it('空输入返回空数组', () => {
    expect(markdownToDocxBlocks('')).toEqual([]);
  });
});

// ── push / revoke / list / needsUpdate ────────────────────────────────────
describe('feishu-share › pushSpaceToFeishu', () => {
  let client: MockShareClient;

  beforeEach(() => {
    // 清空状态文件，保证用例间隔离（同一 UID 会累积 feishu-shares.json）
    clearShareState();
    client = new MockShareClient();
    // 注入 mock client：替换 HttpFeishuShareClient 构造（vi.spyOn 不可行时直接给 push 用）
    // 这里通过 vi.mock 返回的类不可替换，改为在测试中直接验证 push 走 client 接口的编排——
    // push 内部 new HttpFeishuShareClient，我们 spy 其原型方法。
    vi.spyOn(HttpFeishuShareClient.prototype, 'createDocx').mockImplementation(async (title: string) => {
      client.calls.push(`createDocx:${title}`);
      return { document_id: 'doc-1' };
    });
    vi.spyOn(HttpFeishuShareClient.prototype, 'getRootBlockId').mockImplementation(async () => {
      client.calls.push('getRootBlockId');
      return 'root-1';
    });
    vi.spyOn(HttpFeishuShareClient.prototype, 'appendChildren').mockImplementation(async (_d: string, _b: string, children: never[]) => {
      client.calls.push(`appendChildren:${children.length}`);
    });
    vi.spyOn(HttpFeishuShareClient.prototype, 'setPublicAccess').mockImplementation(async (token: string, _t: string, access: string) => {
      client.calls.push(`setPublicAccess:${token}:${access}`);
      client.access[token] = access;
    });
    vi.spyOn(HttpFeishuShareClient.prototype, 'getDocUrl').mockImplementation(async (token: string, type: string) => {
      return `https://mock.feishu.cn/${type}/${token}`;
    });
    vi.spyOn(HttpFeishuShareClient.prototype, 'deleteWikiSpace').mockImplementation(async (spaceId: string) => {
      client.calls.push(`deleteWikiSpace:${spaceId}`);
      client.deleted.push(spaceId);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('成功发布：创建 wiki 空间 → 首页节点 → 写内容 → 设权限 → 返回链接', async () => {
    const res = await pushSpaceToFeishu(UID, 'sp_1', { access: 'anyone' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.url).toMatch(/^https:\/\/mock\.feishu\.cn\/docx\/doc-1$/);
    expect(res.state.wikiNodeObjToken).toBe('doc-1');
    expect(res.state.access).toBe('anyone');
    expect(res.state.fileCount).toBe(2);
    // 编排顺序
    const order = client.calls.filter((c) => c.startsWith('createDocx') || c.startsWith('appendChildren') || c.startsWith('setPublicAccess'));
    expect(order[0]).toBe('createDocx:sp_1');
    expect(order.some((c) => c.startsWith('appendChildren:'))).toBe(true);
    expect(order.some((c) => c.startsWith('setPublicAccess:'))).toBe(true);
  });

  it('重复发布（force=false）幂等返回已有分享', async () => {
    const first = await pushSpaceToFeishu(UID, 'sp_1');
    expect(first.ok).toBe(true);
    const callCount = client.calls.filter((c) => c.startsWith('createDocx')).length;
    const second = await pushSpaceToFeishu(UID, 'sp_1');
    expect(second.ok).toBe(true);
    expect(client.calls.filter((c) => c.startsWith('createDocx')).length).toBe(callCount);
  });

  it('force=true 先删旧空间再重建', async () => {
    await pushSpaceToFeishu(UID, 'sp_1');
    await pushSpaceToFeishu(UID, 'sp_1', { force: true });
    expect(client.calls.filter((c) => c.startsWith('createDocx')).length).toBe(2);
  });

  it('权限映射：tenant → closed + tenant_readable', async () => {
    const res = await pushSpaceToFeishu(UID, 'sp_2', { access: 'tenant' });
    expect(res.ok).toBe(true);
    // 权限设置在 docx 实体上（obj_token=doc-1），非 wiki 节点
    expect(client.access['doc-1']).toBe('tenant');
  });

  it('写入内容包含文件清单（README + docs/guide）', async () => {
    const res = await pushSpaceToFeishu(UID, 'sp_3');
    expect(res.ok).toBe(true);
    const appendCall = client.calls.find((c) => c.startsWith('appendChildren:'));
    expect(appendCall).toBeDefined();
    const count = Number(appendCall?.split(':')[1] ?? 0);
    expect(count).toBeGreaterThan(2); // 标题 + 正文段落
  });
});

describe('feishu-share › list / needsUpdate / revoke', () => {
  beforeEach(() => {
    clearShareState();
    vi.spyOn(HttpFeishuShareClient.prototype, 'createDocx').mockImplementation(async () => ({ document_id: 'doc-1' }));
    vi.spyOn(HttpFeishuShareClient.prototype, 'getRootBlockId').mockImplementation(async () => 'root-1');
    vi.spyOn(HttpFeishuShareClient.prototype, 'appendChildren').mockImplementation(async () => undefined);
    vi.spyOn(HttpFeishuShareClient.prototype, 'setPublicAccess').mockImplementation(async () => undefined);
    vi.spyOn(HttpFeishuShareClient.prototype, 'getDocUrl').mockImplementation(async (token: string, type: string) => `https://mock.feishu.cn/${type}/${token}`);
    vi.spyOn(HttpFeishuShareClient.prototype, 'deleteWikiSpace').mockImplementation(async () => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('list 返回已发布状态', async () => {
    await pushSpaceToFeishu(UID, 'sp_list_1');
    const items = await listFeishuShares(UID);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((s) => s.spaceId === 'sp_list_1')).toBe(true);
  });

  it('needsUpdate：内容哈希一致 → false', async () => {
    await pushSpaceToFeishu(UID, 'sp_hash_1');
    const first = await shareNeedsUpdate(UID, 'sp_hash_1');
    expect(first.needed).toBe(false);
    expect(first.current?.spaceId).toBe('sp_hash_1');
  });

  it('revoke close_link：清状态、不删云端空间', async () => {
    await pushSpaceToFeishu(UID, 'sp_revoke_1');
    const res = await revokeFeishuShare(UID, 'sp_revoke_1', 'close_link');
    expect(res).toEqual({ ok: true });
    expect(await listFeishuShares(UID)).toEqual([]);
  });

  it('revoke delete_space：关闭链接（docx 无删除 API，语义=私密）', async () => {
    await pushSpaceToFeishu(UID, 'sp_revoke_2');
    const setSpy = vi.spyOn(HttpFeishuShareClient.prototype, 'setPublicAccess');
    const res = await revokeFeishuShare(UID, 'sp_revoke_2', 'delete_space');
    expect(res).toEqual({ ok: true });
    expect(setSpy).toHaveBeenCalledWith('doc-1', 'docx', 'private');
  });

  it('revoke 无分享记录幂等成功', async () => {
    const res = await revokeFeishuShare(UID, 'sp_ghost');
    expect(res).toEqual({ ok: true });
  });
});

// ── 错误映射 ──────────────────────────────────────────────────────────────
describe('feishu-share › error mapping', () => {
  it('ShareError 携带 code', () => {
    const err = new ShareError('enterprise_share_disabled', '组织外分享被禁止');
    expect(err.code).toBe('enterprise_share_disabled');
    expect(err.message).toContain('组织外');
  });

  it('push 失败返回结构化 {ok:false, code}', async () => {
    vi.spyOn(HttpFeishuShareClient.prototype, 'createDocx').mockRejectedValue(new ShareError('share_failed', 'mock fail'));
    vi.spyOn(HttpFeishuShareClient.prototype, 'getRootBlockId').mockImplementation(async () => 'r');
    vi.spyOn(HttpFeishuShareClient.prototype, 'appendChildren').mockImplementation(async () => undefined);
    vi.spyOn(HttpFeishuShareClient.prototype, 'setPublicAccess').mockImplementation(async () => undefined);
    vi.spyOn(HttpFeishuShareClient.prototype, 'getDocUrl').mockImplementation(async () => 'https://x');
    const res = await pushSpaceToFeishu(UID, 'sp_err_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('share_failed');
      expect(res.error).toContain('mock fail');
    }
    vi.restoreAllMocks();
  });

  it('缺少写 scope → need_reauthorize', async () => {
    // 动态换 mock：只读 scopes
    const manager = await import('../../../src/main/features/personal_context/manager');
    (manager.getFeishuShareCredential as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accessToken: 'uat_CHANGEME_readonly',
      scopes: ['docx:document:readonly', 'wiki:wiki:readonly'],
      tenantKey: 't',
      unionId: 'u',
    });
    const res = await pushSpaceToFeishu(UID, 'sp_scope_1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('need_reauthorize');
    (manager.getFeishuShareCredential as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: 'uat_CHANGEME_mock_token',
      scopes: ['docx:document', 'wiki:wiki', 'drive:file', 'docs:permission.setting:write_only'],
      tenantKey: 'mock-tenant',
      unionId: 'mock-union',
    });
    vi.restoreAllMocks();
  });
});



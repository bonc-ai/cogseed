import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
const UID = 'discover-feishu-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-discover-feishu-'));
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadFeature() {
  const local = path.join(tmpDir, 'local');
  const cloud = path.join(tmpDir, 'cloud');
  const contextsDir = path.join(cloud, 'contexts');
  const writes: Array<{ path: string; content: string }> = [];
  const revokes: string[] = [];
  const remoteContent: Record<string, string> = { 'doc-1': '这是一篇真实正文。', 'doc-empty': '' };
  vi.doMock('../../../src/main/paths', () => ({
    userCloudRoot: () => cloud,
    userContextsDir: () => contextsDir,
    userKbDiscoverFeishuConfigFile: () => path.join(local, 'kb-discover', 'feishu.json'),
  }));
  vi.doMock('../../../src/main/util/local-secret-store', () => ({
    encryptLocalSecret: (_ctx: unknown, value: string) => `encrypted:${value}`,
    decryptLocalSecret: (_ctx: unknown, value: string) => value.slice('encrypted:'.length),
  }));
  vi.doMock('../../../src/main/features/personal_context/manager', () => ({
    beginAuthorizeWithCredentials: vi.fn(async () => ({ redirectUri: 'http://127.0.0.1/callback', status: { kind: 'connecting', needsReauth: false } })),
    getAuthorizeStatusWithCredentials: vi.fn(async () => ({ kind: 'connected', needsReauth: false })),
    getAuthorizedCredentialWithCredentials: vi.fn(async () => ({ accessToken: 'access-token' })),
    revokeWithCredentials: vi.fn(async (_uid: string, providerId: string) => {
      revokes.push(providerId);
      return { kind: 'disconnected', needsReauth: false };
    }),
  }));
  vi.doMock('../../../src/main/features/personal_context/feishu/api-client', () => ({
    HttpFeishuApiClient: class {
      async listWikiNodes() {
        return [
          { node_token: 'node-1', obj_token: 'doc-1', obj_type: 'docx', title: '产品计划', space_id: 'space-1' },
          { node_token: 'node-empty', obj_token: 'doc-empty', obj_type: 'docx', title: '空白文档', space_id: 'space-1' },
          { node_token: 'node-2', obj_token: 'sheet-1', obj_type: 'sheet', title: '不支持的表格', space_id: 'space-1' },
        ];
      }
      async getDocumentRawContent(id: string) {
        return remoteContent[id] || '';
      }
    },
  }));
  vi.doMock('../../../src/main/features/contexts', () => ({
    writeContextFileForUser: (_uid: string, relpath: string, content: string) => {
      writes.push({ path: relpath, content });
      const full = path.join(contextsDir, relpath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
      return { ok: true, path: relpath };
    },
    updateContextFileForUser: (_uid: string, relpath: string, content: string) => {
      writes.push({ path: relpath, content });
      fs.writeFileSync(path.join(contextsDir, relpath), content, 'utf8');
      return { ok: true, path: relpath };
    },
    deleteContextTargetForUser: (_uid: string, relpath: string) => {
      fs.rmSync(path.join(contextsDir, relpath), { force: true });
      return { ok: true, deletedPaths: [relpath] };
    },
  }));
  const feature = await import('../../../src/main/features/kb_discovery_feishu');
  return { feature, writes, remoteContent, contextsDir, revokes };
}

describe('kb discovery Feishu Wiki', () => {
  it('only writes documents the user explicitly selected', async () => {
    const { feature, writes } = await loadFeature();
    await feature.setFeishuDiscoverApp(UID, { appId: 'cli_test', appSecret: 'secret' });

    await expect(feature.listFeishuWikiDocuments(UID)).resolves.toEqual([
      { id: 'doc-1', nodeId: 'node-1', title: '产品计划', spaceId: 'space-1', imported: false },
      { id: 'doc-empty', nodeId: 'node-empty', title: '空白文档', spaceId: 'space-1', imported: false },
    ]);
    await expect(feature.importFeishuWikiDocuments(UID, ['doc-1'])).resolves.toMatchObject({
      ok: true,
      imported: 1,
      skipped: 0,
      alreadyImported: 0,
      empty: 0,
      items: [{ title: '产品计划', path: expect.stringMatching(/^external\/feishu-wiki\//) }],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toMatch(/^external\/feishu-wiki\//);
    expect(writes[0].content).toContain('这是一篇真实正文。');
    await expect(feature.listFeishuWikiDocuments(UID)).resolves.toEqual([
      { id: 'doc-1', nodeId: 'node-1', title: '产品计划', spaceId: 'space-1', imported: true },
      { id: 'doc-empty', nodeId: 'node-empty', title: '空白文档', spaceId: 'space-1', imported: false },
    ]);
    await expect(feature.importFeishuWikiDocuments(UID, ['doc-1'])).resolves.toMatchObject({ ok: true, imported: 0, skipped: 1, alreadyImported: 1, empty: 0 });
    await expect(feature.importFeishuWikiDocuments(UID, ['doc-empty'])).resolves.toMatchObject({ ok: true, imported: 0, skipped: 1, alreadyImported: 0, empty: 1 });
    expect(writes).toHaveLength(1);
    await expect(feature.getFeishuDiscoverOverview(UID)).resolves.toMatchObject({
      configured: true,
      authorization: 'active',
      importedCount: 1,
      importedDocuments: [{ title: '产品计划', path: expect.stringMatching(/^external\/feishu-wiki\//) }],
    });
  });

  it('updates changed documents and restores missing imported files', async () => {
    const { feature, writes, remoteContent, contextsDir } = await loadFeature();
    await feature.setFeishuDiscoverApp(UID, { appId: 'cli_test', appSecret: 'secret' });
    const imported = await feature.importFeishuWikiDocuments(UID, ['doc-1']);
    const relpath = imported.items[0].path;

    await expect(feature.syncImportedFeishuWikiDocuments(UID)).resolves.toMatchObject({
      ok: true, checked: 1, updated: 0, recovered: 0, unchanged: 1, unavailable: 0, empty: 0, failed: 0,
    });

    remoteContent['doc-1'] = '正文已经在飞书中更新。';
    await expect(feature.syncImportedFeishuWikiDocuments(UID)).resolves.toMatchObject({
      ok: true, checked: 1, updated: 1, recovered: 0, unchanged: 0, items: [{ title: '产品计划', path: relpath, status: 'updated' }],
    });
    expect(fs.readFileSync(path.join(contextsDir, relpath), 'utf8')).toContain('正文已经在飞书中更新。');

    fs.rmSync(path.join(contextsDir, relpath));
    await expect(feature.syncImportedFeishuWikiDocuments(UID)).resolves.toMatchObject({
      ok: true, checked: 1, updated: 0, recovered: 1, unchanged: 0, items: [{ title: '产品计划', path: relpath, status: 'recovered' }],
    });
    expect(fs.existsSync(path.join(contextsDir, relpath))).toBe(true);
    expect(writes).toHaveLength(3);
  });

  it('disconnects without deleting imports and removes the source only after explicit removal', async () => {
    const { feature, contextsDir, revokes } = await loadFeature();
    await feature.setFeishuDiscoverApp(UID, { appId: 'cli_test', appSecret: 'secret' });
    const imported = await feature.importFeishuWikiDocuments(UID, ['doc-1']);
    const importedPath = path.join(contextsDir, imported.items[0].path);

    await expect(feature.disconnectFeishuDiscover(UID)).resolves.toEqual({ ok: true, preservedDocuments: 1 });
    expect(fs.existsSync(importedPath)).toBe(true);

    await expect(feature.removeFeishuDiscoverSource(UID)).resolves.toEqual({ ok: true, removedDocuments: 1, failedDocuments: 0 });
    expect(fs.existsSync(importedPath)).toBe(false);
    expect(revokes).toEqual([feature.FEISHU_KB_DISCOVERY_PROVIDER_ID, feature.FEISHU_KB_DISCOVERY_PROVIDER_ID]);
    await expect(feature.getFeishuDiscoverOverview(UID)).resolves.toMatchObject({ configured: false, importedCount: 0 });
  });
});

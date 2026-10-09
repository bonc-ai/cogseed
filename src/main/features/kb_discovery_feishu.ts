import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readJson, writeJson, nowIso } from '../storage';
import { userCloudRoot, userContextsDir, userKbDiscoverFeishuConfigFile } from '../paths';
import { createLogger } from '../logger';
import * as localSecrets from '../util/local-secret-store';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import * as contexts from './contexts';
import {
  beginAuthorizeWithCredentials,
  getAuthorizeStatusWithCredentials,
  getAuthorizedCredentialWithCredentials,
  revokeWithCredentials,
  type FeishuAppCredentials,
} from './personal_context/manager';
import { HttpFeishuApiClient } from './personal_context/feishu/api-client';

export const FEISHU_KB_DISCOVERY_PROVIDER_ID = 'feishu-kb-discovery';
export const FEISHU_KB_DISCOVERY_SCOPES = ['wiki:wiki:readonly', 'docx:document:readonly'] as const;

const log = createLogger('kb-discovery-feishu');

interface ConfigFile {
  version: 1;
  appId: string;
  appSecretEnc: string;
}

interface ImportedDocument {
  id: string;
  title: string;
  path: string;
  importedAt: string;
  syncedAt?: string;
}

interface ImportFile {
  version: 1;
  items: ImportedDocument[];
}

export interface FeishuWikiDocument {
  id: string;
  nodeId: string;
  title: string;
  spaceId: string;
  imported: boolean;
}

export interface FeishuDiscoverOverview {
  configured: boolean;
  authorization: 'active' | 'not_connected' | 'expired' | 'error';
  importedCount: number;
  importedDocuments: Array<{ title: string; path: string; importedAt: string }>;
  updatedAt?: string;
  error?: string;
}

export interface FeishuSyncResult {
  ok: boolean;
  checked: number;
  updated: number;
  recovered: number;
  unchanged: number;
  unavailable: number;
  empty: number;
  failed: number;
  items: Array<{ title: string; path: string; status: 'updated' | 'recovered' }>;
  error?: string;
}

function secretContext(uid: string): localSecrets.LocalSecretContext {
  return { namespace: 'kb-discovery.feishu', ownerId: uid, recordId: 'app' };
}

function importsFile(uid: string): string {
  return `${userCloudRoot(uid)}/discover/feishu-wiki-imports.json`;
}

function validateApp(value: { appId?: unknown; appSecret?: unknown }): FeishuAppCredentials {
  const appId = typeof value.appId === 'string' ? value.appId.trim() : '';
  const appSecret = typeof value.appSecret === 'string' ? value.appSecret.trim() : '';
  if (!appId || appId.length > 256 || !appSecret || appSecret.length > 1024) throw new Error('请填写有效的 App ID 与 App Secret');
  return { appId, appSecret };
}

async function getApp(uid: string): Promise<FeishuAppCredentials | null> {
  try {
    const raw = await readJson<Partial<ConfigFile>>(userKbDiscoverFeishuConfigFile(uid));
    if (!raw || raw.version !== 1 || typeof raw.appId !== 'string' || !raw.appId || typeof raw.appSecretEnc !== 'string') return null;
    const appSecret = localSecrets.decryptLocalSecret(secretContext(uid), raw.appSecretEnc);
    return { appId: raw.appId, appSecret };
  } catch {
    return null;
  }
}

async function readImports(uid: string): Promise<ImportFile> {
  const raw = await readJson<Partial<ImportFile>>(importsFile(uid));
  return raw && Array.isArray(raw.items) ? { version: 1, items: raw.items.filter((item): item is ImportedDocument => Boolean(item && typeof item.id === 'string' && typeof item.path === 'string')) } : { version: 1, items: [] };
}

function fileStem(title: string, id: string): string {
  const cleaned = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 96);
  const suffix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
  return `${cleaned || 'feishu-document'}-${suffix}`;
}

function displayTitle(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim() || '飞书文档';
}

function documentMarkdown(title: string, id: string, content: string): string {
  return `# ${displayTitle(title)}\n\n来源：飞书 Wiki\n文档 ID：${id}\n\n${content.trim()}\n`;
}

function importedDocumentAbsPath(uid: string, relpath: string): string | null {
  const normalized = String(relpath || '').replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return null;
  const root = path.resolve(userContextsDir(uid));
  const full = path.resolve(root, normalized);
  return full.startsWith(`${root}${path.sep}`) ? full : null;
}

async function restoreContextFile(uid: string, relpath: string, markdown: string) {
  let result = contexts.writeContextFileForUser(uid, relpath, markdown);
  if (result.ok !== false || result.code !== 'duplicate_content') return result;
  const kbVector = await import('./kb_vector');
  const staleRow = kbVector.getFileByPath(uid, relpath);
  if (!staleRow) return result;
  await kbVector.deleteFile(uid, relpath);
  result = contexts.writeContextFileForUser(uid, relpath, markdown);
  return result;
}

async function authorizedClient(uid: string): Promise<HttpFeishuApiClient> {
  const app = await getApp(uid);
  if (!app) throw new Error('请先配置飞书应用');
  const credential = await getAuthorizedCredentialWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app);
  if (!credential) {
    const status = await getAuthorizeStatusWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app);
    if (status.needsReauth) throw new Error('飞书授权已过期，请重新授权');
    throw new Error(status.error || '请先完成飞书授权');
  }
  return new HttpFeishuApiClient({
    accessToken: credential.accessToken,
    refreshAccessToken: async (rejectedAccessToken) => {
      const refreshed = await getAuthorizedCredentialWithCredentials(
        uid,
        FEISHU_KB_DISCOVERY_PROVIDER_ID,
        app,
        { rejectedAccessToken },
      );
      if (refreshed) return refreshed.accessToken;
      const status = await getAuthorizeStatusWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app);
      if (status.needsReauth) throw new Error('飞书授权已过期，请重新授权');
      throw new Error(status.error || '飞书令牌刷新失败，请稍后重试');
    },
  });
}

export async function getFeishuDiscoverOverview(uid: string): Promise<FeishuDiscoverOverview> {
  const [app, imports] = await Promise.all([getApp(uid), readImports(uid)]);
  const importedDocuments = imports.items
    .map((item) => ({ title: item.title.trim() || '飞书文档', path: item.path, importedAt: item.importedAt }))
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  if (!app) return { configured: false, authorization: 'not_connected', importedCount: imports.items.length, importedDocuments };
  const status = await getAuthorizeStatusWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app).catch((error) => ({ kind: 'error', needsReauth: false, error: (error as Error).message }));
  const authorization = status.needsReauth ? 'expired' : (status.kind === 'connected' ? 'active' : (status.kind === 'disconnected' || status.kind === 'connecting' ? 'not_connected' : 'error'));
  return {
    configured: true,
    authorization,
    importedCount: imports.items.length,
    importedDocuments,
    ...(imports.items.length ? { updatedAt: imports.items.map((item) => item.syncedAt || item.importedAt).sort().at(-1) } : {}),
    ...(status.error ? { error: status.error } : {}),
  };
}

export async function setFeishuDiscoverApp(uid: string, input: { appId?: unknown; appSecret?: unknown }): Promise<void> {
  const app = validateApp(input);
  await writeJson(userKbDiscoverFeishuConfigFile(uid), {
    version: 1,
    appId: app.appId,
    appSecretEnc: localSecrets.encryptLocalSecret(secretContext(uid), app.appSecret),
  } satisfies ConfigFile);
}

export async function beginFeishuDiscoverAuthorize(uid: string) {
  const app = await getApp(uid);
  if (!app) throw new Error('请先配置飞书应用');
  return beginAuthorizeWithCredentials(uid, { providerId: FEISHU_KB_DISCOVERY_PROVIDER_ID, app, scopes: FEISHU_KB_DISCOVERY_SCOPES });
}

export async function disconnectFeishuDiscover(uid: string): Promise<{ ok: true; preservedDocuments: number }> {
  const [app, imports] = await Promise.all([getApp(uid), readImports(uid)]);
  if (app) await revokeWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app);
  return { ok: true, preservedDocuments: imports.items.length };
}

export async function removeFeishuDiscoverSource(uid: string): Promise<{ ok: boolean; removedDocuments: number; failedDocuments: number; error?: string }> {
  const [app, imports] = await Promise.all([getApp(uid), readImports(uid)]);
  if (app) {
    await revokeWithCredentials(uid, FEISHU_KB_DISCOVERY_PROVIDER_ID, app).catch((error) => {
      log.warn('Feishu Wiki source removal could not revoke the remote token', {
        user_id: maskId(uid),
        error: logErrorSummary(error),
      });
    });
  }
  let removedDocuments = 0;
  const retained: ImportedDocument[] = [];
  for (const item of imports.items) {
    const absPath = importedDocumentAbsPath(uid, item.path);
    if (!absPath) {
      retained.push(item);
      continue;
    }
    if (!fs.existsSync(absPath)) {
      removedDocuments += 1;
      continue;
    }
    const result = contexts.deleteContextTargetForUser(uid, item.path);
    if (result.ok === false) {
      retained.push(item);
      log.warn('Feishu Wiki source removal could not delete an imported document', {
        user_id: maskId(uid),
        document_id: maskId(item.id),
        path: logPathRef(item.path),
        error: result.error,
      });
      continue;
    }
    removedDocuments += 1;
  }
  if (retained.length) {
    await writeJson(importsFile(uid), { version: 1, items: retained } satisfies ImportFile);
    return {
      ok: false,
      removedDocuments,
      failedDocuments: retained.length,
      error: '部分飞书文档无法删除，请稍后重试',
    };
  }
  fs.rmSync(importsFile(uid), { force: true });
  fs.rmSync(userKbDiscoverFeishuConfigFile(uid), { force: true });
  return { ok: true, removedDocuments, failedDocuments: 0 };
}

export async function listFeishuWikiDocuments(uid: string): Promise<FeishuWikiDocument[]> {
  const [client, imports] = await Promise.all([authorizedClient(uid), readImports(uid)]);
  const importedIds = new Set(imports.items.map((item) => item.id));
  const nodes = await client.listWikiNodes();
  return nodes
    .filter((node) => node.obj_type === 'docx' && node.obj_token && node.node_token)
    .map((node) => ({ id: node.obj_token, nodeId: node.node_token, title: node.title || node.obj_token, spaceId: node.space_id || '', imported: importedIds.has(node.obj_token) }));
}

export async function importFeishuWikiDocuments(uid: string, documentIds: string[]): Promise<{ ok: boolean; imported: number; skipped: number; alreadyImported: number; empty: number; items: Array<{ title: string; path: string }>; error?: string }> {
  const requested = new Set(documentIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256));
  if (requested.size === 0 || requested.size > 100) return { ok: false, imported: 0, skipped: 0, alreadyImported: 0, empty: 0, items: [], error: '请至少选择一篇文档' };
  const [client, documents, importedState] = await Promise.all([authorizedClient(uid), listFeishuWikiDocuments(uid), readImports(uid)]);
  const selected = documents.filter((document) => requested.has(document.id));
  if (selected.length === 0) return { ok: false, imported: 0, skipped: 0, alreadyImported: 0, empty: 0, items: [], error: '所选文档已不可访问，请重新选择' };
  let imported = 0;
  let skipped = 0;
  let alreadyImported = 0;
  let empty = 0;
  const importedItems: Array<{ title: string; path: string }> = [];
  const items = new Map(importedState.items.map((item) => [item.id, item]));
  for (const document of selected) {
    if (items.has(document.id)) {
      skipped += 1;
      alreadyImported += 1;
      continue;
    }
    const content = await client.getDocumentRawContent(document.id);
    if (!content.trim()) {
      skipped += 1;
      empty += 1;
      continue;
    }
    const relpath = `external/feishu-wiki/${fileStem(document.title, document.id)}.md`;
    const markdown = documentMarkdown(document.title, document.id, content);
    const result = contexts.writeContextFileForUser(uid, relpath, markdown);
    if (result.ok === false) return { ok: false, imported, skipped, alreadyImported, empty, items: importedItems, error: result.error };
    const importedAt = nowIso();
    items.set(document.id, { id: document.id, title: displayTitle(document.title), path: relpath, importedAt, syncedAt: importedAt });
    importedItems.push({ title: document.title.trim() || '飞书文档', path: relpath });
    imported += 1;
  }
  await writeJson(importsFile(uid), { version: 1, items: [...items.values()] } satisfies ImportFile);
  return { ok: true, imported, skipped, alreadyImported, empty, items: importedItems };
}

export async function syncImportedFeishuWikiDocuments(uid: string): Promise<FeishuSyncResult> {
  const importedState = await readImports(uid);
  if (!importedState.items.length) {
    return { ok: true, checked: 0, updated: 0, recovered: 0, unchanged: 0, unavailable: 0, empty: 0, failed: 0, items: [] };
  }
  const client = await authorizedClient(uid);
  const nodes = await client.listWikiNodes();
  const documents = new Map(nodes
    .filter((node) => node.obj_type === 'docx' && node.obj_token)
    .map((node) => [node.obj_token, { id: node.obj_token, title: displayTitle(node.title || node.obj_token) }]));
  const syncedAt = nowIso();
  let updated = 0;
  let recovered = 0;
  let unchanged = 0;
  let unavailable = 0;
  let empty = 0;
  let failed = 0;
  const resultItems: FeishuSyncResult['items'] = [];
  const nextItems: ImportedDocument[] = [];

  for (const item of importedState.items) {
    const document = documents.get(item.id);
    if (!document) {
      unavailable += 1;
      nextItems.push(item);
      continue;
    }
    try {
      const content = await client.getDocumentRawContent(document.id);
      if (!content.trim()) {
        empty += 1;
        nextItems.push(item);
        continue;
      }
      const markdown = documentMarkdown(document.title, document.id, content);
      const absPath = importedDocumentAbsPath(uid, item.path);
      if (!absPath) {
        failed += 1;
        log.warn('Feishu Wiki sync rejected an invalid imported path', {
          user_id: maskId(uid),
          document_id: maskId(item.id),
          path: logPathRef(item.path),
        });
        nextItems.push(item);
        continue;
      }
      const exists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
      if (exists && fs.readFileSync(absPath, 'utf8') === markdown) {
        unchanged += 1;
        nextItems.push({ ...item, title: document.title, syncedAt });
        continue;
      }
      const writeResult = exists
        ? contexts.updateContextFileForUser(uid, item.path, markdown)
        : await restoreContextFile(uid, item.path, markdown);
      if (writeResult.ok === false) {
        failed += 1;
        nextItems.push(item);
        continue;
      }
      const status = exists ? 'updated' : 'recovered';
      if (status === 'updated') updated += 1; else recovered += 1;
      resultItems.push({ title: document.title, path: item.path, status });
      nextItems.push({ ...item, title: document.title, syncedAt });
    } catch (error) {
      failed += 1;
      log.warn('Feishu Wiki document sync failed', {
        user_id: maskId(uid),
        document_id: maskId(item.id),
        path: logPathRef(item.path),
        error: logErrorSummary(error),
      });
      nextItems.push(item);
    }
  }

  await writeJson(importsFile(uid), { version: 1, items: nextItems } satisfies ImportFile);
  return {
    ok: true,
    checked: importedState.items.length,
    updated,
    recovered,
    unchanged,
    unavailable,
    empty,
    failed,
    items: resultItems,
  };
}

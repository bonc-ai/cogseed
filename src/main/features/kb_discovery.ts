import * as fs from 'node:fs';
import * as path from 'node:path';

import { nowIso, readJson, writeJson } from '../storage';
import {
  packagedDiscoverCatalogDir,
  userCloudRoot,
  userContextsDir,
} from '../paths';
import * as contexts from './contexts';
import * as spaces from './spaces';
import * as shareFeishu from './share/feishu-share';
import * as shareCogseed from './share/cogseed-publish';
import * as feishuDiscover from './kb_discovery_feishu';

const MANIFEST_FILE = 'manifest.json';
const SUBSCRIPTIONS_FILE = 'subscriptions.json';
const OFFICIAL_CONTEXT_ROOT = 'official';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface DiscoverCatalogItem {
  id: string;
  origin: 'official' | 'published';
  title: string;
  description: string;
  publisher: string;
  category: string;
  tags: string[];
  sourceCount: number;
  updatedAt: string;
  version?: string;
  saved: boolean;
  imported: boolean;
  updateAvailable?: boolean;
  importable: boolean;
  url?: string;
}

export interface DiscoverSourceItem {
  id: string;
  provider: 'official' | 'feishu' | 'team_space';
  title: string;
  description: string;
  scopeLabel: string;
  ownerLabel: string;
  authorization: 'active' | 'not_connected' | 'expired' | 'error';
  syncState: 'ready' | 'idle' | 'error';
  sourceCount: number;
  updatedAt?: string;
  error?: string;
  configured?: boolean;
  documents?: Array<{ title: string; path: string; importedAt: string }>;
}

export interface DiscoverView {
  featured: DiscoverCatalogItem[];
  public: DiscoverCatalogItem[];
  sources: DiscoverSourceItem[];
}

interface OfficialPackage {
  id: string;
  version: string;
  title: string;
  description: string;
  publisher: string;
  category: string;
  tags: string[];
  updatedAt: string;
  files: string[];
}

interface OfficialManifest {
  version: number;
  packages: OfficialPackage[];
}

interface SubscriptionState {
  version: number;
  items: Record<string, { saved?: boolean; importedVersion?: string; importedAt?: string }>;
}

function subscriptionsFile(uid: string): string {
  return path.join(userCloudRoot(uid), 'discover', SUBSCRIPTIONS_FILE);
}

function emptySubscriptions(): SubscriptionState {
  return { version: 1, items: {} };
}

async function readSubscriptions(uid: string): Promise<SubscriptionState> {
  const raw = await readJson<Partial<SubscriptionState>>(subscriptionsFile(uid));
  return raw && raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)
    ? { version: 1, items: raw.items as SubscriptionState['items'] }
    : emptySubscriptions();
}

async function writeSubscriptions(uid: string, state: SubscriptionState): Promise<void> {
  await writeJson(subscriptionsFile(uid), { ...state, updatedAt: nowIso() });
}

function safePackageFile(relative: string): string | null {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..') || !normalized.endsWith('.md')) return null;
  const root = path.resolve(packagedDiscoverCatalogDir());
  const full = path.resolve(root, normalized);
  return full.startsWith(`${root}${path.sep}`) ? full : null;
}

function parseOfficialPackage(value: unknown): OfficialPackage | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const version = typeof item.version === 'string' ? item.version.trim() : '';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const description = typeof item.description === 'string' ? item.description.trim() : '';
  const publisher = typeof item.publisher === 'string' ? item.publisher.trim() : '';
  const category = typeof item.category === 'string' ? item.category.trim() : '';
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt.trim() : '';
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim()).slice(0, 8) : [];
  const files = Array.isArray(item.files) ? item.files.filter((file): file is string => typeof file === 'string' && safePackageFile(file) !== null) : [];
  if (!SAFE_ID.test(id) || !version || !title || !description || !publisher || !category || !updatedAt || files.length === 0) return null;
  return { id, version, title, description, publisher, category, tags, updatedAt, files };
}

export function readOfficialManifest(): OfficialManifest {
  try {
    const file = path.join(packagedDiscoverCatalogDir(), MANIFEST_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { packages?: unknown };
    const packages = Array.isArray(raw.packages) ? raw.packages.map(parseOfficialPackage).filter((item): item is OfficialPackage => item !== null) : [];
    return { version: 1, packages };
  } catch {
    return { version: 1, packages: [] };
  }
}

function packageTargetRoot(packageId: string): string {
  return `${OFFICIAL_CONTEXT_ROOT}/${packageId}`;
}

function isPackageImported(uid: string, packageId: string): boolean {
  try {
    return fs.statSync(path.join(userContextsDir(uid), packageTargetRoot(packageId))).isDirectory();
  } catch {
    return false;
  }
}

function officialItem(entry: OfficialPackage, state: SubscriptionState, uid: string): DiscoverCatalogItem {
  const itemState = state.items[entry.id] || {};
  const imported = isPackageImported(uid, entry.id);
  return {
    id: entry.id,
    origin: 'official',
    title: entry.title,
    description: entry.description,
    publisher: entry.publisher,
    category: entry.category,
    tags: entry.tags,
    sourceCount: entry.files.length,
    updatedAt: entry.updatedAt,
    version: entry.version,
    saved: itemState.saved === true,
    imported,
    updateAvailable: imported && itemState.importedVersion !== entry.version,
    importable: true,
  };
}

function publishedItem(input: { id: string; name: string; description?: string; publisher: string; fileCount: number; updatedAt: string; url?: string }, state: SubscriptionState): DiscoverCatalogItem {
  const itemState = state.items[input.id] || {};
  return {
    id: input.id,
    origin: 'published',
    title: input.name,
    description: input.description || '已发布的共享知识库。',
    publisher: input.publisher,
    category: '团队',
    tags: ['共享知识库'],
    sourceCount: Math.max(0, input.fileCount),
    updatedAt: input.updatedAt,
    saved: itemState.saved === true,
    imported: false,
    importable: false,
    ...(input.url ? { url: input.url } : {}),
  };
}

export async function listDiscoverView(uid: string): Promise<DiscoverView> {
  const manifest = readOfficialManifest();
  const [subscriptions, feishuShares, cogseedShares, userSpaces, feishuOverview] = await Promise.all([
    readSubscriptions(uid),
    shareFeishu.listFeishuShares(uid),
    shareCogseed.listCogseedShares(uid),
    spaces.listSpaces(uid),
    feishuDiscover.getFeishuDiscoverOverview(uid),
  ]);
  const official = manifest.packages.map((entry) => officialItem(entry, subscriptions, uid));
  const published = [
    ...cogseedShares.map((share) => publishedItem({ id: `cogseed:${share.shareId}`, name: share.spaceName, publisher: 'CogSeed Share', fileCount: share.fileCount, updatedAt: share.updatedAt, url: share.url }, subscriptions)),
    ...feishuShares.map((share) => publishedItem({ id: `feishu:${share.spaceId}`, name: share.spaceName, publisher: '飞书共享', fileCount: share.fileCount, updatedAt: share.updatedAt, url: share.url }, subscriptions)),
  ];
  const feishuSource: DiscoverSourceItem = {
    id: 'feishu',
    provider: 'feishu',
    title: '飞书 Wiki',
    description: '仅读取你在飞书授权后明确选择的知识库文档。',
    scopeLabel: feishuOverview.importedCount ? `${feishuOverview.importedCount} 篇已导入知识库` : '尚未导入文档',
    ownerLabel: '飞书知识库只读连接',
    authorization: feishuOverview.authorization,
    syncState: feishuOverview.authorization === 'active' ? 'ready' : (feishuOverview.authorization === 'error' ? 'error' : 'idle'),
    sourceCount: feishuOverview.importedCount,
    configured: feishuOverview.configured,
    documents: feishuOverview.importedDocuments,
    ...(feishuOverview.updatedAt ? { updatedAt: feishuOverview.updatedAt } : {}),
    ...(feishuOverview.error ? { error: feishuOverview.error } : {}),
  };
  const officialSource: DiscoverSourceItem = {
    id: 'official',
    provider: 'official',
    title: 'CogSeed 官方知识库',
    description: '随产品发布、带版本和来源清单的正式知识包。',
    scopeLabel: `${official.length} 个官方知识包`,
    ownerLabel: 'CogSeed',
    authorization: 'active',
    syncState: 'ready',
    sourceCount: official.reduce((total, item) => total + item.sourceCount, 0),
    updatedAt: manifest.packages.map((item) => item.updatedAt).sort().at(-1),
  };
  const teamSource: DiscoverSourceItem = {
    id: 'team-space',
    provider: 'team_space',
    title: '团队空间与共享知识库',
    description: '当前账号真实可访问的空间与已发布知识库。',
    scopeLabel: `${userSpaces.length} 个空间 · ${published.length} 个已发布知识库`,
    ownerLabel: '当前账号',
    authorization: userSpaces.length || published.length ? 'active' : 'not_connected',
    syncState: userSpaces.length || published.length ? 'ready' : 'idle',
    sourceCount: published.reduce((total, item) => total + item.sourceCount, 0),
  };
  return { featured: official, public: [...official, ...published], sources: [officialSource, feishuSource, teamSource] };
}

export async function setDiscoverSubscription(uid: string, itemId: string, saved: boolean): Promise<{ ok: boolean; saved: boolean }> {
  if (typeof itemId !== 'string' || itemId.length < 1 || itemId.length > 160) throw new Error('invalid discovery item id');
  const state = await readSubscriptions(uid);
  state.items[itemId] = { ...state.items[itemId], saved: saved === true };
  await writeSubscriptions(uid, state);
  return { ok: true, saved: saved === true };
}

export async function importOfficialPackage(uid: string, packageId: string): Promise<{ ok: boolean; imported: number; updated: number; skipped: number; error?: string }> {
  if (!SAFE_ID.test(String(packageId || ''))) return { ok: false, imported: 0, updated: 0, skipped: 0, error: 'invalid package id' };
  const entry = readOfficialManifest().packages.find((item) => item.id === packageId);
  if (!entry) return { ok: false, imported: 0, updated: 0, skipped: 0, error: 'package not found' };
  const subscriptions = await readSubscriptions(uid);
  const previousVersion = subscriptions.items[entry.id]?.importedVersion;
  const updateExisting = previousVersion !== entry.version;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const sourceRel of entry.files) {
    const sourceAbs = safePackageFile(sourceRel);
    if (!sourceAbs) return { ok: false, imported, updated, skipped, error: 'invalid package source' };
    const targetRel = `${packageTargetRoot(entry.id)}/${path.basename(sourceRel)}`;
    const targetAbs = path.join(userContextsDir(uid), targetRel);
    let content = '';
    try { content = fs.readFileSync(sourceAbs, 'utf8'); } catch { return { ok: false, imported, updated, skipped, error: 'package source unreadable' }; }
    if (fs.existsSync(targetAbs)) {
      if (!updateExisting) {
        skipped += 1;
        continue;
      }
      const result = contexts.updateContextFileForUser(uid, targetRel, content);
      if (result.ok === false) return { ok: false, imported, updated, skipped, error: result.error };
      updated += 1;
    } else {
      const result = contexts.writeContextFileForUser(uid, targetRel, content);
      if (result.ok === false) return { ok: false, imported, updated, skipped, error: result.error };
      imported += 1;
    }
  }
  subscriptions.items[entry.id] = { ...subscriptions.items[entry.id], importedVersion: entry.version, importedAt: nowIso() };
  await writeSubscriptions(uid, subscriptions);
  return { ok: true, imported, updated, skipped };
}

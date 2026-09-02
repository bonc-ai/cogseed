/**
 * 发布到 CogSeed Share 后端（方案 C）：空间内容 → cogseed-share API → 公网分享页。
 *
 * - 复用 feishu-share 的 collectSpaceMarkdown（读原始文件，完整内容）
 * - 携带 join_mode / member_permission（权限弹窗设置真实生效）
 * - 后端地址 + API Key 存本地配置（<uid>/local/config/personal-context/cogseed-share.json）
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso } from '../../storage';
import { userLocalConfigDir } from '../../paths';
import { collectSpaceMarkdown } from './feishu-share';

const log = createLogger('share:cogseed');

const CONFIG_FILE = 'cogseed-share.json';
const MAX_MD_BYTES = 200 * 1024;

export interface CogseedShareConfig {
  /** 后端地址（如 https://share.cogseed.dev；本地调试 http://localhost:3000） */
  baseUrl: string;
  apiKey: string;
}

export interface CogseedShareState {
  spaceId: string;
  spaceName: string;
  url: string;
  shareId: string;
  access: string;
  joinMode: 'direct' | 'apply' | 'invite';
  memberPermission: 'view_export' | 'view_only' | 'hidden';
  contentHash: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

function configFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'personal-context', CONFIG_FILE);
}

export async function getCogseedShareConfig(uid: string): Promise<CogseedShareConfig | null> {
  try {
    const raw = await readJson<{ baseUrl?: unknown; apiKey?: unknown }>(configFile(uid));
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() && typeof raw.apiKey === 'string' && raw.apiKey.trim()) {
      return { baseUrl: raw.baseUrl.trim().replace(/\/+$/, ''), apiKey: raw.apiKey.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function setCogseedShareConfig(uid: string, config: CogseedShareConfig | null): Promise<void> {
  const file = configFile(uid);
  if (!config || !config.baseUrl.trim() || !config.apiKey.trim()) {
    try { fs.unlinkSync(file); } catch { /* noop */ }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeJson(file, { baseUrl: config.baseUrl.trim().replace(/\/+$/, ''), apiKey: config.apiKey.trim() });
}

function readStates(uid: string): CogseedShareState[] {
  try {
    const raw = fs.readFileSync(path.join(userLocalConfigDir(uid), 'personal-context', 'cogseed-shares.json'), 'utf8');
    const parsed = JSON.parse(raw) as { items?: CogseedShareState[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeStates(uid: string, items: CogseedShareState[]): void {
  const file = path.join(userLocalConfigDir(uid), 'personal-context', 'cogseed-shares.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: nowIso(), items }, null, 2), 'utf8');
}

export type CogseedPublishResult =
  | { ok: true; state: CogseedShareState }
  | { ok: false; code: 'not_configured' | 'backend_error' | 'publish_failed'; error: string };

/** 发布/更新空间到 cogseed-share 后端 */
export async function publishSpaceToCogseedShare(
  uid: string,
  spaceId: string,
  spaceMeta: { name: string; joinMode: 'direct' | 'apply' | 'invite'; memberPermission: 'view_export' | 'view_only' | 'hidden'; description?: string },
  opts: { force?: boolean } = {},
): Promise<CogseedPublishResult> {
  const cfg = await getCogseedShareConfig(uid);
  if (!cfg) return { ok: false, code: 'not_configured', error: '尚未配置 CogSeed 共享服务（后端地址 + API Key）' };

  const existing = readStates(uid).find((s) => s.spaceId === spaceId);
  if (existing && !opts.force) return { ok: true, state: existing };

  try {
    const { md, count } = await collectSpaceMarkdown(uid, spaceId);
    const contentHash = crypto.createHash('sha256').update(md).digest('hex');

    // 幂等：hash 相同返回 changed:false（后端已实现）
    const res = await fetch(`${cfg.baseUrl}/api/v1/shares`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Owner-Uid': uid,
      },
      body: JSON.stringify({
        name: spaceMeta.name || spaceId,
        joinMode: spaceMeta.joinMode ?? 'direct',
        memberPermission: spaceMeta.memberPermission ?? 'view_export',
        contentHash,
        files: md
          ? [{ path: 'index.md', title: spaceMeta.name || spaceId, contentMd: md }]
          : [],
      }),
    });
    const body = (await res.json()) as { ok?: boolean; shareId?: string; url?: string; error?: string };
    if (!res.ok || body.ok !== true) {
      return { ok: false, code: 'backend_error', error: body.error || `后端返回 ${res.status}` };
    }
    const state: CogseedShareState = {
      spaceId,
      spaceName: spaceMeta.name || spaceId,
      url: body.url ?? `${cfg.baseUrl}/s/${body.shareId}`,
      shareId: body.shareId ?? '',
      access: 'link',
      joinMode: spaceMeta.joinMode ?? 'direct',
      memberPermission: spaceMeta.memberPermission ?? 'view_export',
      contentHash,
      fileCount: count,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    const items = readStates(uid).filter((s) => s.spaceId !== spaceId);
    items.push(state);
    writeStates(uid, items);
    log.info('cogseed share published', { spaceId, shareId: state.shareId, files: count });
    return { ok: true, state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('cogseed share publish failed', { spaceId, error: message });
    return { ok: false, code: 'publish_failed', error: message };
  }
}

/** 同步权限策略（join_mode/member_permission 变化时增量更新） */
export async function syncCogseedPolicy(
  uid: string,
  spaceId: string,
  policy: { joinMode?: 'direct' | 'apply' | 'invite'; memberPermission?: 'view_export' | 'view_only' | 'hidden' },
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getCogseedShareConfig(uid);
  const state = readStates(uid).find((s) => s.spaceId === spaceId);
  if (!cfg || !state) return { ok: true }; // 未发布或未配置：无需同步
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/shares/${state.shareId}/policy`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(policy.joinMode ? { joinMode: policy.joinMode } : {}),
        ...(policy.memberPermission ? { memberPermission: policy.memberPermission } : {}),
      }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error || `后端返回 ${res.status}` };
    // 更新本地状态
    const items = readStates(uid).map((s) => s.spaceId === spaceId
      ? { ...s, joinMode: policy.joinMode ?? s.joinMode, memberPermission: policy.memberPermission ?? s.memberPermission, updatedAt: nowIso() }
      : s);
    writeStates(uid, items);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listCogseedShares(uid: string): Promise<CogseedShareState[]> {
  return readStates(uid);
}

export async function getCogseedShare(uid: string, spaceId: string): Promise<CogseedShareState | null> {
  return readStates(uid).find((s) => s.spaceId === spaceId) ?? null;
}

export async function revokeCogseedShare(uid: string, spaceId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getCogseedShareConfig(uid);
  const state = readStates(uid).find((s) => s.spaceId === spaceId);
  if (!state) return { ok: true };
  if (cfg) {
    try {
      await fetch(`${cfg.baseUrl}/api/v1/shares/${state.shareId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  writeStates(uid, readStates(uid).filter((s) => s.spaceId !== spaceId));
  return { ok: true };
}

/** 读取成员待审列表（管理面板用） */
export async function listCogseedMembers(uid: string, spaceId: string): Promise<{ ok: boolean; members?: unknown[]; error?: string }> {
  const cfg = await getCogseedShareConfig(uid);
  const state = readStates(uid).find((s) => s.spaceId === spaceId);
  if (!cfg || !state) return { ok: true, members: [] };
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/shares/${state.shareId}/members`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    const body = (await res.json()) as { ok?: boolean; members?: unknown[]; error?: string };
    return { ok: body.ok === true, members: body.members ?? [], error: body.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 审核成员 */
export async function reviewCogseedMember(uid: string, spaceId: string, memberId: number, verdict: 'approve' | 'reject'): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getCogseedShareConfig(uid);
  const state = readStates(uid).find((s) => s.spaceId === spaceId);
  if (!cfg || !state) return { ok: false, error: '未配置或未发布' };
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/shares/${state.shareId}/members/${memberId}/${verdict}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: body.ok === true, error: body.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 已装 Agent 更新失败的记录 —— 卡片与详情页据此提示"更新失败，仍可使用 1.x"（产品 2026-10-13）。
 *
 * 更新失败时旧版原样保留（见 `marketplace_agent_replace`），用户能继续用，但需要知道"有新版没更成"，
 * 否则会以为已是最新。记录放在市场目录下**单独一个文件**，不放进 Agent 目录：Agent 目录的内容摘要是跨语言契约，
 * 往里放一个状态文件会改变摘要。
 *
 * 只存**原因代码**不存报错原文：报错里可能带路径或服务端细节，而这条记录会被界面读取。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userMarketplaceDir } from '../paths';
import { compareVersions } from '../util/app-version-compat';

export type AgentUpdateFailureReason =
  | 'app_too_old'
  | 'dependency_disabled'
  | 'dependency_missing'
  | 'builtin_unavailable'
  | 'package_invalid'
  | 'network'
  | 'unknown';

export interface AgentUpdateFailure {
  /** 没能更新到的版本。 */
  target_version: string;
  at: number;
  reason: AgentUpdateFailureReason;
}

const FILE = '_agent_update_failures.json';

/** 把更新时抛出的错误归成原因代码；认不出的归 `unknown`，不把原文带出去。 */
export function classifyUpdateFailure(err: unknown): AgentUpdateFailureReason {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  if (msg.includes('requires cogseed')) return 'app_too_old';
  if (msg.includes('built-in capability')) return 'builtin_unavailable';
  // 下载的内容没通过校验：摘要/大小不符、不是字节流、包格式不合法。重试同一版本也会得到同样结果，
  // 与"网络不可用"区分开，不让用户以为过会儿就好。
  if (msg.includes('digest_mismatch') || msg.includes('size_mismatch') || msg.includes('unexpected_content_type') || msg.includes('agent_package_')) return 'package_invalid';
  if (msg.includes('not approved') || msg.includes('status_not_approved') || msg.includes('disabled')) return 'dependency_disabled';
  if (msg.includes('content_not_found') || msg.includes('not_found')) return 'dependency_missing';
  if (msg.includes('http ') || msg.includes('fetch') || msg.includes('timed out') || msg.includes('network') || msg.includes('econn')) return 'network';
  return 'unknown';
}

function filePath(uid: string): string {
  return path.join(userMarketplaceDir(uid), FILE);
}

export function readAgentUpdateFailures(uid: string): Record<string, AgentUpdateFailure> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(uid), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AgentUpdateFailure> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const r = v as Partial<AgentUpdateFailure> | null;
      if (!r || typeof r.target_version !== 'string' || typeof r.at !== 'number') continue;
      out[id] = { target_version: r.target_version, at: r.at, reason: (r.reason as AgentUpdateFailureReason) || 'unknown' };
    }
    return out;
  } catch {
    return {};
  }
}

function write(uid: string, map: Record<string, AgentUpdateFailure>): void {
  const file = filePath(uid);
  if (Object.keys(map).length === 0) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 记录一次更新失败。写记录本身出错不能让更新流程再多一个失败，所以吞掉。 */
export function recordAgentUpdateFailure(uid: string, agentId: string, info: { targetVersion: string; reason: AgentUpdateFailureReason }): void {
  try {
    const map = readAgentUpdateFailures(uid);
    map[agentId] = { target_version: info.targetVersion, at: Date.now(), reason: info.reason };
    write(uid, map);
  } catch { /* 记录是锦上添花 */ }
}

/** 更新成功或卸载后清掉记录。 */
export function clearAgentUpdateFailure(uid: string, agentId: string): void {
  try {
    const map = readAgentUpdateFailures(uid);
    if (!(agentId in map)) return;
    delete map[agentId];
    write(uid, map);
  } catch { /* 同上 */ }
}

/**
 * 纯判定：这条失败记录现在还算数吗？本机版本已追上（或超过）没能更新到的版本，就不算了——
 * 比如用户后来手动装上了。版本比较不了（无法解析）时按"仍算数"处理，宁可多提示一次。
 */
export function activeUpdateFailure(
  failures: Readonly<Record<string, AgentUpdateFailure>>,
  agentId: string,
  localVersion: string | undefined,
): AgentUpdateFailure | null {
  const f = failures[agentId];
  if (!f) return null;
  if (localVersion && compareVersions(localVersion, f.target_version) >= 0) return null;
  return f;
}

/**
 * 渠道外部用户 → P3394 Peer 映射（Q3）。
 *
 * 飞书入站消息只带 open_id（机器标识，人不可读且跨租户不稳定展示）。
 * 本模块把「哪个渠道实例里见过的哪个外部用户」稳定地映射成一个可读
 * 的 peerAlias（`user-<平台缩写>-<open_id 尾 8>`），供 P3394 信封的
 * sender.agent_id / 后续协商引用。持久化仿 team-projection：同步读写状态文件
 * （channel-peer-map.json），tmp+rename 原子落盘。PR209 评审 M2：落
 * `<uid>/local/`（每用户私有域，符合 AGENTS.md 数据域规范——此前机器级
 * 全局文件可跨账号列出所有联系人）；全部函数以 userId 为首参。
 *
 * 接线点在 messaging/manager.handleInboundLocked（飞书入站即记录，
 * 幂等、失败仅 warn，不阻塞派发）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { MESSAGING_PLATFORMS, type MessagingPlatform } from '../messaging/types';
import { p3394StateFile } from './runtime-paths';
import { userLocalRoot } from '../../paths';

const log = createLogger('p3394-bridge:channel-peer-map');

export interface ChannelPeerRecord {
  platform: MessagingPlatform;
  instanceId: string;
  /** 渠道侧用户标识（飞书 = open_id）。 */
  externalUserId: string;
  /** 渠道侧显示名（飞书可能不回填；仅在提供且变化时更新）。 */
  externalUserName?: string;
  /** 稳定可读的 P3394 peer 别名（首次生成后不变）。 */
  peerAlias: string;
  firstSeenAt: string;
  updatedAt: string;
}

interface ChannelPeerMapFile {
  schema_version: 1;
  peers: Record<string, ChannelPeerRecord>;
}

const SCHEMA_VERSION = 1;
const MAX_EXTERNAL_USER_ID_LENGTH = 160;
const MAX_EXTERNAL_USER_NAME_LENGTH = 120;
const ALIAS_TAIL_LENGTH = 8;

/** 平台缩写（peerAlias 的中段；稳定优先于时髦，永不改值）。 */
const PLATFORM_ABBREVIATIONS: Record<MessagingPlatform, string> = {
  telegram: 'tg',
  feishu_lark: 'fs',
  wecom: 'wc',
  wechat_personal: 'wx',
};

export function channelPeerPlatformAbbr(platform: MessagingPlatform): string {
  return PLATFORM_ABBREVIATIONS[platform] || 'ch';
}

/** 纯函数：peerAlias 生成规则 `user-<平台缩写>-<外部 id 尾 8>`。
 *  独立导出，使派发侧（信封 sender）不依赖持久化查询也能得到与
 *  映射表一致的稳定别名。 */
export function channelPeerAlias(platform: MessagingPlatform, externalUserId: string): string {
  const tail = externalUserId.slice(-ALIAS_TAIL_LENGTH);
  return `user-${channelPeerPlatformAbbr(platform)}-${tail || 'unknown'}`;
}

function peerMapFile(userId: string): string {
  // PR209 评审 M2：open_id + 真实显示名是用户私有数据——必须落
  // `<uid>/local/` 域（AGENTS.md），不再写机器级全局文件。
  return path.join(userLocalRoot(userId), 'channel-peer-map.json');
}

function peerKey(platform: MessagingPlatform, instanceId: string, externalUserId: string): string {
  return `${platform}:${instanceId}:${externalUserId}`;
}

/** Always reads the file（低频写入、每文件读一次）：文件是唯一事实源，
 *  测试也因此天然隔离。损坏/缺省返回空表。 */
function readPeers(userId: string): Map<string, ChannelPeerRecord> {
  const out = new Map<string, ChannelPeerRecord>();
  try {
    const parsed = JSON.parse(fs.readFileSync(peerMapFile(userId), 'utf8')) as Partial<ChannelPeerMapFile>;
    if (parsed.schema_version === SCHEMA_VERSION && parsed.peers && typeof parsed.peers === 'object') {
      for (const [key, record] of Object.entries(parsed.peers)) {
        if (record && typeof record.platform === 'string' && typeof record.instanceId === 'string'
          && typeof record.externalUserId === 'string' && typeof record.peerAlias === 'string') {
          out.set(key, record as ChannelPeerRecord);
        }
      }
    }
  } catch { /* first run */ }
  return out;
}

function persistPeers(userId: string, map: Map<string, ChannelPeerRecord>): void {
  try {
    const file = peerMapFile(userId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: ChannelPeerMapFile = {
      schema_version: SCHEMA_VERSION,
      peers: Object.fromEntries(map.entries()),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('channel peer map persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function normalizeExternalUserId(raw: string): string {
  return String(raw || '').trim().slice(0, MAX_EXTERNAL_USER_ID_LENGTH);
}

function normalizeExternalUserName(raw?: string): string | undefined {
  const name = typeof raw === 'string' ? raw.trim().slice(0, MAX_EXTERNAL_USER_NAME_LENGTH) : '';
  return name || undefined;
}

/** 幂等建/更新渠道 peer 记录。已存在且名字未变时不写盘（热路径零 IO）；
 *  名字变化只更新显示名，peerAlias 首次生成后保持稳定。持久化失败仅
 *  warn，返回内存态记录——映射是尽力而为的元数据，不是派发前置条件。 */
export function ensureChannelPeer(
  userId: string,
  platform: MessagingPlatform,
  instanceId: string,
  externalUserId: string,
  externalUserName?: string,
): ChannelPeerRecord {
  if (!MESSAGING_PLATFORMS.includes(platform)) throw new Error('invalid platform');
  const instance = String(instanceId || '').trim();
  const external = normalizeExternalUserId(externalUserId);
  const name = normalizeExternalUserName(externalUserName);
  if (!instance || instance.length > 160) throw new Error('invalid instance id');
  if (!external) throw new Error('invalid external user id');
  const key = peerKey(platform, instance, external);
  const map = readPeers(userId);
  const existing = map.get(key);
  const now = new Date().toISOString();
  if (existing) {
    if (!name || name === existing.externalUserName) return existing;
    const updated: ChannelPeerRecord = { ...existing, externalUserName: name, updatedAt: now };
    map.set(key, updated);
    persistPeers(userId, map);
    return updated;
  }
  const record: ChannelPeerRecord = {
    platform,
    instanceId: instance,
    externalUserId: external,
    ...(name ? { externalUserName: name } : {}),
    peerAlias: channelPeerAlias(platform, external),
    firstSeenAt: now,
    updatedAt: now,
  };
  map.set(key, record);
  persistPeers(userId, map);
  return record;
}

/** 精确查询一条渠道 peer 映射；不存在返回 null。 */
export function lookupChannelPeer(
  userId: string,
  platform: MessagingPlatform,
  instanceId: string,
  externalUserId: string,
): ChannelPeerRecord | null {
  if (!MESSAGING_PLATFORMS.includes(platform)) return null;
  const instance = String(instanceId || '').trim();
  const external = normalizeExternalUserId(externalUserId);
  if (!instance || !external) return null;
  return readPeers(userId).get(peerKey(platform, instance, external)) || null;
}

/** 列出全部渠道 peer 映射（快照副本）。 */
export function listChannelPeers(userId: string): ChannelPeerRecord[] {
  return [...readPeers(userId).values()];
}

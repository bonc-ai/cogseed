/**
 * 第三期「渠道即节点」：把每个运行中的 messaging 渠道实例注册为
 * P3394 花名册节点（node_kind = channel_bridge），智能体经 p3394_send
 * 点名渠道节点即可主动触达用户（翻译官模式的出站方向）。
 *
 * 投递走本模块的 deliverToChannelBridge（host-adapter 分流），不经
 * outbound-hub 的 HTTP dial——渠道节点没有网络端点，它是进程内虚拟节点。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getP3394PeerRegistry } from '../p3394_bridge/app-wiring';
import { buildP3394BridgeManifest } from '../p3394_bridge/manifest';
import { p3394ObjectStoreResolve, p3394ObjectsRoot } from '../p3394_bridge/object-store';
import type { P3394Envelope } from '../p3394_bridge/envelope';
import type { MessagingInstance } from './types';

export const CHANNEL_BRIDGE_NODE_KIND = 'channel_bridge' as const;

/** 渠道节点 agent_id：`channel-<instanceId>`（稳定、可反解）。 */
export function channelBridgeAgentId(instanceId: string): string {
  return `channel-${instanceId}`;
}

export function instanceIdFromChannelBridgeAgentId(agentId: string): string | null {
  return agentId.startsWith('channel-') ? agentId.slice('channel-'.length) : null;
}

function syntheticChannelAgent(instance: MessagingInstance) {
  return {
    agent_id: channelBridgeAgentId(instance.id),
    name: `${instance.displayName}`,
    description_zh: `消息渠道节点（${instance.platform}）`,
    description_en: `Messaging channel node (${instance.platform})`,
    workflow: '',
    category: 'general',
    source: 'custom' as const,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
  };
}

/** 注册/刷新渠道节点（实例启用后调用；幂等，重复注册即 touch）。 */
export function registerChannelBridgeNode(instance: MessagingInstance): { ok: boolean; error?: string } {
  const registry = getP3394PeerRegistry();
  if (!registry) return { ok: false, error: 'p3394_bridge_unavailable' };
  const manifestResult = buildP3394BridgeManifest(syntheticChannelAgent(instance) as never);
  if (!manifestResult.ok) {
    const failure = manifestResult as Extract<typeof manifestResult, { ok: false }>;
    return { ok: false, error: failure.error.message };
  }
  const registered = registry.register({
    identity: { agent_id: channelBridgeAgentId(instance.id), display_name: instance.displayName },
    aliases: [instance.displayName],
    manifest: manifestResult.manifest,
    endpoints: [],
    capabilities: ['messaging.relay', 'messaging.proactive'],
    node_kind: 'channel_bridge',
    locality: 'in_process',
  });
  if (registered.ok) return { ok: true };
  const regFailure = registered as Extract<typeof registered, { ok: false }>;
  return { ok: false, error: regFailure.error.message };
}

export function unregisterChannelBridgeNode(instanceId: string): void {
  const registry = getP3394PeerRegistry();
  registry?.revoke(channelBridgeAgentId(instanceId));
}

/** p3394_send 到渠道节点：取信封文本 → 经渠道主动发给 owner → 回执信封。
 *
 * 护栏（设计风险表：渠道即节点后智能体滥发消息）：
 * - 白名单：allowedSenders 为 sender agent_id 列表；undefined = 全放行
 *   （现状兼容），空数组 = 拒绝所有。
 * - 限流：内存滑动窗口，per (uid, instance, sender) 10 条/分钟 +
 *   per (uid, instance) 总 30 条/分钟。进程内护栏（重启清零），
 *   防的是失控智能体刷屏，不是计费精度。
 * - 卡片：parts 中 {type:'json', data:{card}} 格子还原为投递 card 参数
 *   （飞书交互卡片等渠道特有结构，信封不丢特性）。
 * - 文件（T2a 渠道回传，2026-08-25 真机修复）：resource/artifact/image
 *   part 支持 filesToResourceParts 产生的两种真实 uri 形态——data:…;
 *   base64 内联（格式白名单→解码→digest 校验→落临时文件）与
 *   p3394-object:sha256 引用（格式白名单→对象存储 resolve→根边界复
 *   核）。不接受裸本地绝对路径（信封是不可信输入，任意路径读取属
 *   信息泄露）；文件名走 basename 白名单清洗。文本送达后逐个经
 *   sendFile 投递（上限 5 个/信封），不单独消耗限流配额；文件
 *   sourceKey 带序号独立幂等；失败上报不回滚文本。 */
const CHANNEL_BRIDGE_FILE_PARTS_MAX = 5;
/** 严格白名单：本实现接受的内容寻址引用形态（sha256 十六进制 64 位）。 */
const SAFE_OBJECT_URI_RE = /^p3394-object:sha256:[a-f0-9]{64}$/;
/** 严格白名单：本实现接受的内联形态（data:mime[;param];base64,payload）。 */
const SAFE_DATA_URI_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]*(?:;[a-z0-9.+=-]+)*;base64,[A-Za-z0-9+/=]+$/;

const MEDIA_EXT_BY_TYPE: Record<string, string> = {
  'text/plain': '.txt', 'text/markdown': '.md', 'application/json': '.json',
  'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp', 'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

/** 文件名白名单清洗：去路径段（防穿越）、只留安全字符、截断。 */
function sanitizeFileName(raw: unknown, fallbackExt: string): string {
  const base = typeof raw === 'string' ? path.basename(String(raw).trim()) : '';
  const cleaned = base.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g, '_').slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'p3394-file-' + crypto.randomUUID().slice(0, 8) + fallbackExt;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(cleaned) ? cleaned : cleaned + fallbackExt;
}

/** 把信封文件 part 物化成本地文件（sendProactiveFile 需要路径）。
 *  返回 null 表示不可物化（跳过，不阻塞其余投递）。 */
function materializeFilePart(part: { uri?: unknown; name?: unknown; media_type?: unknown; digest?: unknown }): { path: string; name: string } | null {
  const uri = typeof part.uri === 'string' ? part.uri : '';
  const mediaType = typeof part.media_type === 'string' && MEDIA_EXT_BY_TYPE[part.media_type] ? part.media_type : '';
  const ext = mediaType ? MEDIA_EXT_BY_TYPE[mediaType] : '';
  const name = sanitizeFileName(part.name, ext);
  if (!uri) return null;
  // ① 内容寻址引用：格式白名单 → 对象存储 resolve → 对象根边界复核。
  if (SAFE_OBJECT_URI_RE.test(uri)) {
    const resolved = p3394ObjectStoreResolve(uri);
    if (resolved.ok === false) return null;
    const objectsRoot = p3394ObjectsRoot();
    if (resolved.value !== objectsRoot && !resolved.value.startsWith(objectsRoot + path.sep)) return null;
    return { path: resolved.value, name };
  }
  // ② 内联 data:…;base64,：格式白名单 → 解码 → digest 校验（不符丢
  //    弃）→ 临时目录落盘（hex 命名 + tmp 根边界复核，幂等覆盖）。
  if (!SAFE_DATA_URI_RE.test(uri)) return null;
  const b64 = uri.slice(uri.indexOf(';base64,') + ';base64,'.length);
  let buf: Buffer;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (!buf.length) return null;
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (typeof part.digest === 'string' && /^[a-f0-9]{64}$/i.test(part.digest) && part.digest.toLowerCase() !== digest) return null;
  const tmpRoot = os.tmpdir();
  const tmp = path.join(tmpRoot, 'p3394-channel-' + digest.slice(0, 24) + ext);
  if (!tmp.startsWith(tmpRoot + path.sep)) return null;
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(tmp, buf);
  } catch { return null; }
  return { path: tmp, name };
}

export async function deliverToChannelBridge(
  uid: string,
  agentId: string,
  envelope: P3394Envelope,
  send: (uid: string, input: { instanceId: string; recipientId: string; text: string; sourceKey: string; card?: Record<string, unknown> }) => Promise<unknown>,
  ownerResolver: (uid: string, instanceId: string) => Promise<{ recipientId: string } | null>,
  options?: {
    allowedSenders?: string[];
    /** 文件投递通道（生产环境传 manager.sendProactiveFile 的包装）。
     *  未提供时信封里的文件 part 被忽略（向后兼容）。 */
    sendFile?: (uid: string, input: { instanceId: string; recipientId: string; path: string; name?: string; sourceKey: string }) => Promise<unknown>;
  },
): Promise<{ ok: true; receipt: P3394Envelope } | { ok: false; error: string }> {
  const instanceId = instanceIdFromChannelBridgeAgentId(agentId);
  if (!instanceId) return { ok: false, error: 'p3394_not_a_channel_bridge' };
  const senderId = envelope.sender?.agent_id || '';
  if (options && Array.isArray(options.allowedSenders) && !options.allowedSenders.includes(senderId)) {
    return { ok: false, error: 'p3394_channel_bridge_sender_not_allowed' };
  }
  if (!admitChannelBridgeSend(uid, instanceId, senderId)) {
    return { ok: false, error: 'p3394_channel_bridge_rate_limited' };
  }
  const text = (envelope.payload?.parts || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) return { ok: false, error: 'p3394_channel_bridge_empty_text' };
  const cardPart = (envelope.payload?.parts || []).find((part) => part.type === 'json'
    && part.data && typeof part.data === 'object' && 'card' in (part.data as Record<string, unknown>));
  const card = cardPart ? (cardPart.data as { card?: Record<string, unknown> }).card : undefined;
  const owner = await ownerResolver(uid, instanceId);
  if (!owner) return { ok: false, error: 'p3394_channel_bridge_no_owner' };
  try {
    await send(uid, {
      instanceId,
      recipientId: owner.recipientId,
      text,
      sourceKey: `p3394:${envelope.message_id}`,
      ...(card ? { card } : {}),
    });
  } catch (error) {
    // AbortError 单独识别：调用方（如 proactive sendToSelf）依赖它区分
    // "turn 中止"（not_sent/aborted）与真实投递失败。
    if ((error as Error)?.name === 'AbortError') {
      return { ok: false, error: 'p3394_channel_bridge_aborted' };
    }
    return { ok: false, error: (error as Error).message || 'p3394_channel_bridge_delivery_failed' };
  }
  // T2a 文件投递：文本送达后，把信封里的 resource/artifact/image part
  // 物化（data:/object: 两种真实形态，白名单校验）后逐个发给 owner。
  // 单个文件失败不回滚已送达的文本（文件是附件语义），但整个投递按
  // 失败上报（调用方可重试整信封——文本走幂等台账不会重复，文件
  // sourceKey 独立带序号，重试同样幂等）。
  let deliveredFiles = 0;
  if (options?.sendFile) {
    const fileParts = (envelope.payload?.parts || [])
      .filter((part) => part.type === 'resource' || part.type === 'artifact' || part.type === 'image')
      .slice(0, CHANNEL_BRIDGE_FILE_PARTS_MAX)
      .map((part) => materializeFilePart(part))
      .filter((f): f is { path: string; name: string } => f !== null);
    for (let i = 0; i < fileParts.length; i += 1) {
      const file = fileParts[i];
      try {
        await options.sendFile(uid, {
          instanceId,
          recipientId: owner.recipientId,
          path: file.path,
          name: file.name,
          sourceKey: `p3394:${envelope.message_id}:file:${i}`,
        });
        deliveredFiles += 1;
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          return { ok: false, error: 'p3394_channel_bridge_aborted' };
        }
        return { ok: false, error: `p3394_channel_bridge_file_failed:${(error as Error).message || 'unknown'}` };
      }
    }
  }
  const receipt: P3394Envelope = {
    ...envelope,
    message_id: `${envelope.message_id}:receipt`,
    kind: 'event',
    performative: 'inform',
    sender: { agent_id: agentId },
    recipients: [envelope.sender],
    payload: { parts: [{ type: 'text', text: deliveredFiles > 0 ? `channel bridge delivered (${deliveredFiles} file(s))` : 'channel bridge delivered' }] },
  };
  return { ok: true, receipt };
}

// ── 系统触达统一信封入口（G-13：触达与对话同路）───────────────────────
// touchpoints / 个人简报 / sendToSelf 等系统侧主动通知，不再直调
// sendProactive，而是构造 P3394 信封经 deliverToChannelBridge 投递——
// 与智能体触达同一条路（护栏 + 回执 + 台账运单号）。sendProactive 退为
// 底层物理传输（台账/重试/幂等能力保留，只被本路径与 agent 分流调用）。
// 系统身份（cogseed:<uid>）不走白名单（白名单管智能体，不管用户自配置
// 的系统通知），但仍受实例级限流保护（防系统 bug 刷屏）。




// ── 限流（进程内滑动窗口）──────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const PER_SENDER_LIMIT = 10;
const PER_INSTANCE_LIMIT = 30;

/** sender 维度窗口：`<uid>\0<instance>\0<sender>` → 时间戳数组。 */
const _senderWindows = new Map<string, number[]>();
/** 实例维度窗口：`<uid>\0<instance>` → 时间戳数组。 */
const _instanceWindows = new Map<string, number[]>();

function admitWindow(windowKey: string, store: Map<string, number[]>, limit: number, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const stamps = (store.get(windowKey) || []).filter((ts) => ts > cutoff);
  if (stamps.length >= limit) {
    store.set(windowKey, stamps);
    return false;
  }
  stamps.push(now);
  store.set(windowKey, stamps);
  return true;
}

/** 限流判定 + 记账。放行时两级窗口都记账；任一级超限拒绝（不记账，重试
 * 仍会被同一窗口挡住直到滑出）。系统身份（cogseed:* 前缀，sendSystemVia
 * ChannelBridge 的 sender）聚合了全部系统通知（简报/触达点/提醒），单个
 * 系统身份的 10 条/分钟会误伤正常业务——系统身份只受实例级 30 条/分钟
 * 约束（防 bug 刷屏依然有效）。 */
function admitChannelBridgeSend(uid: string, instanceId: string, senderAgentId: string, now = Date.now()): boolean {
  const isSystemSender = senderAgentId.startsWith('cogseed:');
  if (!isSystemSender) {
    const senderOk = admitWindow(`${uid}\0${instanceId}\0${senderAgentId}`, _senderWindows, PER_SENDER_LIMIT, now);
    if (!senderOk) return false;
  }
  const instanceOk = admitWindow(`${uid}\0${instanceId}`, _instanceWindows, PER_INSTANCE_LIMIT, now);
  if (!instanceOk) {
    // 回滚 sender 记账，避免实例级限流白白消耗单个 sender 的配额
    if (!isSystemSender) {
      const key = `${uid}\0${instanceId}\0${senderAgentId}`;
      const stamps = _senderWindows.get(key);
      if (stamps && stamps.length) {
        stamps.pop();
        _senderWindows.set(key, stamps);
      }
    }
    return false;
  }
  return true;
}

/** 测试专用：清空限流窗口。 */
export function resetChannelBridgeRateLimitsForTests(): void {
  _senderWindows.clear();
  _instanceWindows.clear();
}

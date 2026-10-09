/**
 * 飞书 Channel Adapter descriptor 合约（P3394 标准 §4.3 / §13，SDK §5.3）。
 *
 * 飞书渠道是 §4.3 两类渠道里的「人类触达面」（Human Presentation
 * Channel）：它不承载智能体间的任务语义，只把人类消息与智能体回复
 * 翻译成 P3394 信封往返。本 descriptor 是并行合约——描述"这个渠道
 * 适配器是什么、保真哪些语义"，不切主链路；由 messaging/channel-bridge
 * 在渠道节点注册时同步挂载（见其模块内 descriptor Map）。
 *
 * 语义声明（保守口径，宁可少声明不可虚报）：
 * - roles: listener（长连接 WSClient 接收入站）+ dialer（主动发 owner）。
 * - artifacts: 'referenced'——G-17 入站图片以 feishu-image:<image_key>
 *   引用式投影，出站文件走引用/物化，均不内联字节。
 * - streaming/durable_tasks/cancellation/multi_party_sessions: 均不支持
 *   （卡片流式是渲染层增强，不构成协议级双向流）。
 * - identity_proofs: `feishu-open_id:<owner open_id>`，owner 未配置时为
 *   空数组（descriptor 仍可产出，协商侧据此知道渠道尚无可信归属）。
 */

import { buildP3394ChannelDescriptor, type P3394ChannelDescriptor } from './channel-adapter';
import type { MessagingInstance, MessagingInstanceInternal } from '../messaging/types';

/** 渠道节点注册时声明的能力标签（与 P3394PeerRecord.capabilities 对齐）。
 *  放在这里而非 channel-bridge 硬编码，保证 descriptor 与节点注册共用
 *  同一来源——两处声明不会漂移。 */
export const FEISHU_CHANNEL_CAPABILITIES = ['messaging.relay', 'messaging.proactive'] as const;

/** Reverse-DNS adapter id（SDK §5.3 约定形态）。 */
export const FEISHU_CHANNEL_DESCRIPTOR_ID = 'org.cogseed.channel.feishu_lark';

/** 适配器承载的 URI scheme：G-17 入站图片投影的引用式 uri 前缀。 */
export const FEISHU_IMAGE_URI_SCHEME = 'feishu-image';

/** Build the Feishu channel descriptor for one running instance. The owner
 *  open id (main-process-private) becomes the channel's identity proof;
 *  a missing owner yields an empty proof list instead of an error — the
 *  descriptor describes the channel as configured, not as wished. */
export function buildFeishuChannelDescriptor(
  instance: MessagingInstance | MessagingInstanceInternal,
): P3394ChannelDescriptor {
  const owner = (instance as MessagingInstanceInternal).ownerExternalUserId?.trim() || '';
  return buildP3394ChannelDescriptor({
    id: FEISHU_CHANNEL_DESCRIPTOR_ID,
    schemes: [FEISHU_IMAGE_URI_SCHEME],
    roles: ['listener', 'dialer'],
    bindings: [`feishu-lark:instance:${instance.id}`],
    capabilities: {
      streaming: 'none',
      durable_tasks: false,
      cancellation: false,
      artifacts: 'referenced',
      multi_party_sessions: false,
      identity_proofs: owner ? [`feishu-open_id:${owner}`] : [],
    },
  });
}

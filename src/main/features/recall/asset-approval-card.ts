/**
 * 审批卡片的对话内下发（specs/008 US-406 / T034）。
 *
 * 形态与 KSTAR 复盘卡同款（`features/kstar/review-card.ts` → `task-closure.ts`）：
 * main 生成卡片载荷 → 经既有 `features/group_chat/bus.ts::enqueue` 作为一条消息
 * 下发 → 渲染层在对话气泡里挂载。**不新建平行派发路径**（AGENTS.md 硬约束）。
 *
 * 这里保留 `port` 注入而不是直接 import bus：与复盘卡同款的好处是测试可以只验
 * "载荷长什么样、什么时候发"，不必拉起整条 group_chat。
 */

import { t } from '../../i18n';
import {
  buildAssetChangeApprovalCard,
  type AssetChangeApprovalCard,
  type AssetChangeProposal,
} from './asset-approval-service';

/** 载荷构造器从这里再导出一份：卡片模块是"卡片长什么样"的归属地，
 *  调用方（工具层、测试）不该为了拿载荷去 import 服务模块。 */
export { buildAssetChangeApprovalCard };

export interface AssetApprovalCardPort {
  send(input: {
    userId: string;
    cid: string;
    text: string;
    asset_change_approval_card: AssetChangeApprovalCard;
  }): Promise<{ id: string }>;
}

/** 卡片文案（main 生成、走 main locales；渲染层的按钮文案另走 renderer locales）。 */
export function assetApprovalCardText(proposal: AssetChangeProposal, assetTitle: string): string {
  return [
    t('recall.asset_approval.card_title'),
    `${t('recall.asset_approval.card_asset')}: ${String(assetTitle || '').slice(0, 120)}`,
    `${t('recall.asset_approval.card_fields')}: ${proposal.fields.join(' / ')}`,
    `${t('recall.asset_approval.card_reason')}: ${proposal.reason.slice(0, 600)}`,
  ].join('\n');
}

export async function postAssetChangeApprovalCard(
  userId: string,
  cid: string,
  proposal: AssetChangeProposal,
  assetTitle: string,
  port: AssetApprovalCardPort,
): Promise<{ ok: true; msg: { id: string }; card: AssetChangeApprovalCard }> {
  const card = buildAssetChangeApprovalCard(proposal, assetTitle);
  const msg = await port.send({
    userId,
    cid,
    text: assetApprovalCardText(proposal, assetTitle),
    asset_change_approval_card: card,
  });
  return { ok: true, msg, card };
}

/** 生产用的下发口：唯一派发路径是 `bus.enqueue`（与复盘卡同款参数）。 */
export function busAssetApprovalCardPort(): AssetApprovalCardPort {
  return {
    send: async (payload) => {
      const bus = await import('../group_chat/bus');
      const message = await bus.enqueue({
        uid: payload.userId,
        cid: payload.cid,
        fromActorId: 'commander',
        text: payload.text,
        asset_change_approval_card: payload.asset_change_approval_card,
        forceTo: ['user'],
      });
      return { id: message.id };
    },
  };
}

/** 已退役的治理待办不能再次进入夜间认知建议列表或独立详情。 */
import { describe, expect, it } from 'vitest';
import { renderCognition } from './helpers/cognition-renderer';
import { groupCognitionInbox } from '../../src/main/features/recall/formal-assets/inbox';
const conflict = { id: 'conflict:cand-1', kind: 'classification_conflict', urgency: 'confirm', title: '同一句话有两种归属', candidateId: 'cand-1', detail: '需要核对归属', actions: ['claim', 'reject', 'defer'] };
const other = { id: 'rule-boundary:asset-a', kind: 'rule_boundary_missing', urgency: 'low_disturbance', title: '规则适用范围不清', assetId: 'asset-a', boundary: { applicableWhen: ['项目排查'], forbiddenWhen: [] }, actions: ['set_boundary'] };
const state = () => ({ inbox: [conflict, other], inboxGroups: groupCognitionInbox([conflict, other] as never) });
describe('旧共同治理页面已退役', () => {
  for (const route of [{ name: 'activity' }, { name: 'activity', inboxId: conflict.id }, { name: 'activity', inboxId: other.id }]) {
    it(`治理问题不进入建议列表或独立操作详情：${route.inboxId || '列表'}`, () => {
      const html = renderCognition(route, state());
      expect(html).not.toContain(conflict.title);
      expect(html).not.toContain(other.title);
      expect(html).not.toContain('data-inbox-boundary-form');
      expect(html).not.toContain('data-act="inbox-conflict-claim"');
      expect(html).not.toContain('data-act="inbox-boundary-save"');
      expect(html).toContain('需要关注 0');
    });
  }
  it('统一收件箱读取失败显示重试状态，不伪装成空态', () => {
    const html = renderCognition({ name: 'activity' }, { ...state(), inboxError: 'offline' });
    // 收件箱同时承载巡检发现；读失败必须可见，不能被当成「没有建议」。
    expect(html).toContain('清单没能读取');
    expect(html).toContain('部分变化未能读取');
    expect(html).toContain('data-act="refresh"');
    expect(html).not.toContain('当前没有需要关注的建议');
  });
});

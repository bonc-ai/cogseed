import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const asset = { id: 'asset-a', title: '清单展示规则', scope: 'general', type: 'cognition', contentCategory: 'rule', status: 'active', version: '3', activeVersion: '3', statement: '原正文' };
const proposal = { id: 'ap-a', assetId: asset.id, baselineVersion: '3', state: 'pending', fields: ['statement', 'applicableWhen', 'forbiddenWhen'], payload: { statement: '读取失败时显示待核对，不能用零代替未知。', applicableWhen: ['完整清单查询'], forbiddenWhen: ['清单读取失败'] }, beforeValues: { statement: '原正文', applicableWhen: ['查询清单'] }, reason: '合成用户要求完整清单区分未知状态，助手据此提出正文改进。', createdAt: '2026-10-13T14:00:00Z' };
const button = (decision: string) => ({ dataset: { act: 'activity-approval', id: proposal.id, decision }, disabled: false, getAttribute: () => null, setAttribute: vi.fn(), removeAttribute: vi.fn() });
const load = (extra: Record<string, unknown> = {}, route = {}) => loadCognitionAssets({ assets: [asset], assetApprovals: [proposal], ...extra }, { name: 'activity', ...route });

describe('系统活动接入真实资产修改审批', () => {
  it('明确提议深链未找到或正在读取时，绝不回退成第一条可操作提议', async () => {
    const missing = load({}, { approvalId: 'ap-missing' });
    const html = missing.render();
    expect(html).toContain('这条提议暂不可用');
    expect(html).not.toContain('data-act="activity-approval"');
    const loading = load({ loading: true }, { approvalId: 'ap-missing' });
    expect(loading.render()).toContain('正在读取活动');
    expect(loading.render()).not.toContain('data-act="activity-approval"');
    const cached = load({ loading: true }, { approvalId: proposal.id });
    cached.ns.api.call = vi.fn();
    await cached.ns.activityController.handleClick(button('confirm'));
    expect(cached.ns.api.call).not.toHaveBeenCalled();
  });
  it('生产详情样式能被 CSS 解析器完整读取，抽屉和使用边界规则不被损坏选择器吞掉', () => {
    const from = path.resolve(__dirname, '../../src/renderer/modules/cognition-assets/prototype.css');
    const sheet = postcss.parse(fs.readFileSync(from, 'utf8'), { from });
    const selectors: string[] = [];
    sheet.walkRules(rule => { selectors.push(rule.selector); });
    expect(selectors.some(selector => selector.includes('.ca-prototype-boundaries dd'))).toBe(true);
    expect(selectors.some(selector => selector.includes('.is-drawer-open'))).toBe(true);
    expect(selectors.some(selector => selector.includes('button:is(.ca-library-scrim,.ca-activity-scrim)'))).toBe(true);
  });

  it('没有夜间候选时点开真实提议，标准详情提供原值、拟更新值、版本和审批影响', () => {
    const loaded = load({}, { approvalId: proposal.id }); const html = loaded.render();
    expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['approval:ap-a']);
    expect(html).toContain('需要关注 1');
    expect(html).toContain('ui-resource-card');
    for (const text of ['当前 v3', '提议基于 v3', '内容', '本次变化', '原正文', proposal.payload.statement, proposal.reason, '批准后更新目标资产并记录新版本', '建议更新']) expect(html).toContain(text);
    expect(html).not.toContain('ca-review-action');
    expect(html).not.toContain('<h3>建议动作</h3>');
    const facts = html.slice(html.indexOf('class="ca-library-facts"'), html.indexOf('ca-activity-detail-body'));
    expect(facts).toContain('建议更新');
    expect(html).not.toContain('data-f="judgment"');
    const footer = html.slice(html.indexOf('<footer class="ca-activity-detail-footer ca-detail-footer">'));
    for (const decision of ['confirm', 'defer', 'reject']) expect(footer).toContain(`data-decision="${decision}"`);
  });

  it('深链在窄屏打开真实提议，终态详情只读且不返回审批操作', () => {
    const loaded = load({ assets: [{ ...asset, ...proposal.payload, version: '4', activeVersion: '4' }], assetVersions: { assetId: asset.id, versions: [{ version: '4', snapshot: { ...asset, ...proposal.payload, version: '4' } }] }, assetApprovals: [{ ...proposal, state: 'confirmed', appliedVersion: '4', decidedAt: '2026-10-13T15:00:00Z' }] }, { approvalId: proposal.id });
    const html = loaded.render();
    expect(loaded.ns.activityModel().attention).toHaveLength(0);
    expect(loaded.ns.activityModel().done).toHaveLength(1);
    expect(html).toContain(proposal.payload.statement);
    expect(html).not.toContain('data-act="activity-approval"');
  });

  it('版本变化、目标缺失及读取失败禁用确认，旧快照也不能触发写入', async () => {
    for (const extra of [{ assets: [{ ...asset, version: '4' }] }, { assets: [] }, { candidatesError: 'failed' }, { assetsError: 'failed' }]) {
      const loaded = load(extra, { approvalId: proposal.id }); loaded.render();
      loaded.ns.api.call = vi.fn();
      await loaded.ns.activityController.handleClick(button('confirm'));
      expect(loaded.ns.api.call).not.toHaveBeenCalled();
      expect(loaded.render()).toContain('目标资产不可用、版本已变化或清单读取失败');
    }
  });

  it('稍后处理调用同一审批服务，重新读取后仍在关注列表；拒绝后进入已处理', async () => {
    for (const [decision, state] of [['defer', 'deferred'], ['reject', 'rejected']]) {
      const loaded = load(); loaded.render();
      loaded.ns.router.go = vi.fn();
      loaded.ns.api.call = vi.fn(async () => ({ ok: true, state }));
      loaded.ns.reload = vi.fn(async () => { loaded.store.assetApprovals = [{ ...proposal, state }]; });
      await loaded.ns.activityController.handleClick(button(decision));
      expect(loaded.ns.api.call).toHaveBeenCalledWith('recall.assets.approval.decide', { proposalId: proposal.id, decision });
      expect(loaded.ns.reload).toHaveBeenCalledOnce();
      expect(loaded.ns.activityModel().attention).toHaveLength(decision === 'defer' ? 1 : 0);
      expect(loaded.ns.activityModel().done).toHaveLength(decision === 'reject' ? 1 : 0);
    }
  });

  it('确认只审批指定提议，正式内容与版本由服务端提交；冲突抛错也重新读取', async () => {
    const loaded = load(); loaded.render(); loaded.ns.router.go = vi.fn(); loaded.ns.alertUser = vi.fn();
    loaded.ns.api.call = vi.fn(async () => { throw Object.assign(new Error('version conflict'), { state: 'superseded' }); });
    loaded.ns.reload = vi.fn(async () => { loaded.store.assetApprovals = [{ ...proposal, state: 'superseded' }]; });
    await loaded.ns.activityController.handleClick(button('confirm'));
    expect(loaded.ns.api.call).toHaveBeenCalledWith('recall.assets.approval.decide', { proposalId: proposal.id, decision: 'confirm' });
    expect(loaded.ns.reload).toHaveBeenCalledOnce(); expect(loaded.ns.alertUser).toHaveBeenCalledOnce();
    expect(loaded.render()).not.toContain('data-act="activity-approval"');
    expect(loaded.store.assets[0].statement).toBe('原正文');
  });

  it('队列读口加载审批记录，返回畸形数据时保留上次内容并显示未知状态', async () => {
    const loaded = load();
    loaded.ns.api.call = vi.fn(async (channel: string) => channel === 'recall.candidates.list'
      ? { candidates: [], assetApprovals: [proposal] } : channel === 'recall.assets.list' ? { assets: [asset] } : { ok: true });
    await loaded.ns.reload();
    expect(loaded.store.assetApprovals).toEqual([proposal]);
    expect(loaded.render()).toContain('需要关注 1');
    loaded.ns.api.call = vi.fn(async (channel: string) => channel === 'recall.candidates.list'
      ? { candidates: [], assetApprovals: 'broken' } : channel === 'recall.assets.list' ? { assets: [asset] } : { ok: true });
    await loaded.ns.reload();
    expect(loaded.store.assetApprovals).toEqual([proposal]);
    expect(loaded.store.candidatesError).toContain('invalid asset approval');
    expect(loaded.render()).toContain('需要关注 待核对');
    expect(loaded.render()).not.toContain('需要关注 0');
  });

  it('详情使用原生定义列表和共享卡片，来源正文按文本转义', () => {
    const loaded = load({ assetApprovals: [{ ...proposal, reason: '<img src=x onerror=alert(1)>' }] }, { approvalId: proposal.id });
    const html = loaded.render();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    const library = loadCognitionAssets({ assets: [{ ...asset, applicableWhen: ['查询清单'], forbiddenWhen: ['来源不明'] }] }, { name: 'overview', assetId: asset.id }).render();
    for (const text of ['<dl><dt>适用条件</dt>', '查询清单', '<dt>禁止与例外</dt>', '来源不明']) expect(library).toContain(text);
    expect(library).not.toContain('class="field ca-prototype-boundaries"');
    expect(library).toContain('ui-resource-card');
  });
});

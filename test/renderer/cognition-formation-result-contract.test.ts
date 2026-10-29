import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const pending = { id: 'candidate-a', summary: '周报规则', judgment: '周报单列风险和下一步，说明负责人。', suggestedType: 'rule', suggestedScope: 'report', status: 'pending_review', capabilities: { countsAsPending: true, canPromote: true } };
const asset = { id: 'asset-a', type: 'rule', status: 'active', version: '1', title: '周报规则', statement: pending.judgment };
const confirmed = { ...pending, status: 'confirmed', promotedAssetId: asset.id, capabilities: { isTerminal: true } };

function fixture(response: unknown, recovered = false) {
  const toast = vi.fn();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'recall.candidates.promote') return response;
    if (channel === 'recall.candidates.read') return { candidate: recovered ? confirmed : pending };
    if (channel === 'recall.assets.read') return { asset: recovered ? asset : undefined };
    if (channel === 'recall.candidates.list') return { candidates: [recovered ? confirmed : pending] };
    if (channel === 'personalOntology.candidates.list') return { candidate_updates: [] };
    if (channel === 'recall.assets.list') return { assets: recovered ? [asset] : [] };
    if (channel === 'cognition.ontology.snapshot') return { ontology: { records: {} } };
    return { ok: true };
  });
  const loaded = loadCognitionAssets({ candidates: [pending] }, { name: 'activity', candidateId: pending.id }, { cogseed: { invoke }, uiToast: toast });
  return { ...loaded, invoke, toast };
}

describe('形成结果必须能对应真实确认与资产身份', () => {
  it('从已保存认知回看形成记录时，落在已处理而非需要关注', () => {
    const f = fixture({ candidate: confirmed, asset });
    f.store.candidates = [confirmed, { ...pending, id: 'still-pending' }];
    f.ns.router.go({ name: 'activity', candidateId: confirmed.id });
    expect(f.store.route).toMatchObject({ candidateId: confirmed.id, activityView: 'done', activityDone: '1' });
    const html = f.render();
    expect(html).toContain('查看已保存资产');
    expect(html).not.toContain('data-id="candidate:still-pending"');
  });
  it('空成功响应仍保留待核对，不宣称正式保存', async () => {
    const f = fixture({ ok: true });
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.candidates[0].status).toBe('pending_review');
    expect(f.store.lastPromoted).toBeNull();
    expect(JSON.stringify(f.toast.mock.calls)).toContain('暂时无法确认');
    expect(JSON.stringify(f.toast.mock.calls)).not.toContain('已成为正式资产');
  });

  it('响应丢失后，通过同一候选和资产的重新读取核对成功，不重复晋升', async () => {
    const f = fixture({}, true);
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.lastPromoted.assetId).toBe(asset.id);
    expect(f.store.candidates[0].status).toBe('confirmed');
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'recall.candidates.promote')).toHaveLength(1);
  });

  it('其他候选或其他资产的成功结果不能替代当前确认', async () => {
    const f = fixture({ candidate: { ...confirmed, id: 'other' }, asset });
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.lastPromoted).toBeNull();
    expect(f.store.candidates[0].id).toBe(pending.id);
    expect(JSON.stringify(f.toast.mock.calls)).not.toContain('已成为正式资产');
  });

  it('重新核对失败时不能用并发广播留下的旧成功缓存冒充本次回执', async () => {
    const f = fixture({});
    f.store.candidates = [confirmed]; f.store.assets = [asset];
    f.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'recall.candidates.read') throw new Error('read failed');
      return { ok: true };
    });
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.lastPromoted).toBeNull();
    expect(JSON.stringify(f.toast.mock.calls)).not.toContain('已成为正式资产');
  });

  it('完整对应的确认结果直接保留实际资产入口', async () => {
    const f = fixture({ candidate: confirmed, asset });
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.lastPromoted.assetId).toBe(asset.id);
    expect(f.store.candidates[0].promotedAssetId).toBe(asset.id);
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'recall.candidates.list')).toHaveLength(0);
  });

  it('读取失败、缺失状态和终态记录不能切换在用版本', async () => {
    for (const state of [{ ...asset, status: undefined }, { ...asset, status: 'archived' }, { ...asset, status: 'deleted' }, { ...asset, type: 'experience' }]) {
      const f = fixture({});
      f.store.assets = [state];
      await expect(f.ns.actions.selectAssetVersion(asset.id, '2')).rejects.toThrow('不允许');
      expect(f.invoke).not.toHaveBeenCalled();
    }
    const f = fixture({});
    f.store.assets = [asset]; f.store.assetsError = 'disk unavailable';
    await expect(f.ns.actions.selectAssetVersion(asset.id, '2')).rejects.toThrow('刷新');
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('整理读取失败保留旧记录并标记未知；完整读取后恢复', async () => {
    const f = fixture({});
    const capture = { id: 'capture-a', status: 'failed', actions: ['retry'] };
    f.store.captures = [capture];
    f.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'recall.captures.list') throw new Error('capture unreadable');
      return { ok: true };
    });
    await f.ns.loaders.snapshot();
    expect(f.store.captures).toEqual([capture]);
    expect(f.store.capturesError).toBe('capture unreadable');
    f.invoke.mockImplementation(async (channel: string) => channel === 'recall.captures.list' ? { items: [], counts: {} } : { ok: true });
    await f.ns.loaders.snapshot();
    expect(f.store.captures).toEqual([]);
    expect(f.store.capturesError).toBe('');
  });

  it('后台失败不再触发关注任务全量扫描，仅加载来源历史', async () => {
    const f = fixture({});
    const recent = { id: 'recent', status: 'completed' };
    const older = { id: 'older-failure', status: 'failed', actions: ['retry'] };
    f.invoke.mockImplementation(async (channel: string, payload?: any) => {
      if (channel === 'recall.captures.list') return payload?.statuses
        ? { captures: [older], nextCursor: null }
        : { captures: [recent], nextCursor: 'more-history', counts: {} };
      return { ok: true };
    });
    await f.ns.loaders.snapshot();
    expect(f.store.captures.map((row: any) => row.id)).toEqual(['recent']);
    expect(f.store.capturesError).toBe('');
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'recall.captures.list')).toHaveLength(1);
  });
});


describe('独立本体保存的真实结果身份', () => {
  const ontologyPending = { ...pending, proposalTarget: 'ontology' };
  const handoff = { status: 'integrated', commandId: 'ontology-command', recordIds: ['ontology-record'], moduleIds: ['personal'], ontologyRevision: 3 };
  const integrated = { ...ontologyPending, status: 'integrated', ontologyHandoff: handoff };
  it('用真实本体回执确认保存，更新已处理状态并不生成资产入口', async () => {
    const f = fixture({ candidate: integrated, ontologyHandoff: handoff });
    f.store.candidates = [ontologyPending];
    f.store.lastPromoted = { assetId: 'older-asset' };
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.candidates[0].status).toBe('integrated');
    expect(f.store.lastPromoted).toBeNull();
    expect(JSON.stringify(f.toast.mock.calls)).toContain('本体变化已保存');
    expect(JSON.stringify(f.toast.mock.calls)).not.toContain('已成为正式资产');
  });
  it('不接受另一个本体命令的成功回执替代当前变化', async () => {
    const f = fixture({ candidate: integrated, ontologyHandoff: { ...handoff, commandId: 'another-command' } });
    f.store.candidates = [ontologyPending];
    await f.ns.actions.adoptCandidate(pending.id);
    expect(f.store.candidates[0].status).toBe('pending_review');
    expect(JSON.stringify(f.toast.mock.calls)).not.toContain('本体变化已保存');
  });
});

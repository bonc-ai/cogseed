import { describe, expect, it } from 'vitest';

import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

const BASE = {
  id: 'detail-1',
  title: '上线前先核对影响范围',
  type: 'rule',
  status: 'active',
  statement: '先确认受影响的用户。\n再核对回滚方案。',
  applicableWhen: ['发布前检查'],
  forbiddenWhen: ['临时草稿'],
  version: '3',
  activeVersion: '2',
  evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }, { kind: 'conversation', id: 'conv-1' }],
};

const renderDetail = (asset: Record<string, unknown> = BASE, state: Record<string, unknown> = {}) => renderCognition(
  { name: 'overview', assetId: BASE.id },
  { assets: [asset], ...state },
);

const useCard = (html: string) => {
  const start = html.indexOf('ca-asset-usage-card');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
};

describe('正式认知资产详情页', () => {
  it.each(['personal', 'rule', 'template', 'skill_method', 'fact'])('%s 使用同一阅读骨架，正文和当前版边界完整可见', (type) => {
    const html = renderDetail({ ...BASE, type });

    expect((html.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(html).toContain('ca-asset-page');
    expect(html).toContain('ca-asset-stack');
    expect(html).not.toContain('ca-detail-side');
    expect(html).toContain('ca-asset-body');
    expect(html).toContain('先确认受影响的用户。\n再核对回滚方案。');
    expect(html).toContain('发布前检查');
    expect(html).toContain('临时草稿');
    expect(html).toContain('在用版本 v2');
    expect(html).toContain('2 条来源记录');
    expect(html.indexOf('ca-asset-body')).toBeLessThan(html.indexOf('ca-detail-origin'));
    expect(html.indexOf('ca-detail-origin')).toBeLessThan(html.indexOf('ca-asset-usage-card'));
    expect(html.indexOf('ca-asset-usage-card')).toBeLessThan(html.indexOf('ca-detail-history'));
    expect(html.indexOf('ca-detail-history')).toBeLessThan(html.indexOf('ca-asset-manage-card'));
    expect(html).toContain('aria-label="允许后续任务使用"');
  });

  it('未读到使用与采用数据时显示读取中，成功读取空结果后才显示零次', () => {
    const pending = useCard(renderDetail());
    expect(pending).toContain('使用记录读取中');
    expect(pending).toContain('采用记录读取中');
    expect(pending).not.toContain('其中模型确认采用 0 次');

    const loaded = useCard(renderDetail(BASE, {
      assetTimeline: { assetId: BASE.id, items: [], loading: false, failed: false },
      adoptionReceipts: { assetId: BASE.id, items: [], loading: false, failed: false },
    }));
    expect(loaded).toContain('被任务用过 0 次');
    expect(loaded).toContain('其中模型确认采用 0 次');
    expect(loaded).toContain('还没有被真实使用过');
  });

  it('读取失败显示可重试入口，不把失败写成零次', () => {
    const html = useCard(renderDetail(BASE, {
      assetTimeline: { assetId: BASE.id, items: [], loading: false, failed: true },
      adoptionReceipts: { assetId: BASE.id, items: [], loading: false, failed: true },
    }));
    expect(html).toContain('使用记录暂不可用');
    expect(html).toContain('采用记录暂不可用');
    expect(html).toContain('data-act="asset-timeline-retry"');
    expect(html).toContain('data-act="asset-adoption-retry"');
    expect(html).not.toContain('其中模型确认采用 0 次');
  });

  it('使用次数旁解释采用口径，旧版长期引用收起但仍可回到来源', () => {
    const proof = {
      id: 'proof-1', kind: 'projection_confirmed', occurredAt: '2026-09-28T10:00:00Z',
      refs: { assetId: BASE.id, projectionId: 'proj-1', version: '1', authorization: 'user_confirmed', purpose: 'user_pinned', conversationId: 'conv-1' },
    };
    const html = renderDetail(BASE, {
      assetTimeline: { assetId: BASE.id, items: [proof], loading: false, failed: false },
      adoptionReceipts: { assetId: BASE.id, items: [], loading: false, failed: false },
      sources: [{ kind: 'conversation', items: [{ kind: 'conversation', id: 'conv-1', title: '发布检查', status: 'ready' }] }],
    });
    expect(useCard(html)).toContain('被任务用过 1 次');
    expect(useCard(html)).toContain('真正采用只计模型确认的回执');
    expect(useCard(html)).not.toContain('只记真实用过（实际采用）');
    expect(html).toContain('<details class="ca-stale-pin-detail">');
    expect(html).toContain('查看引用与处理办法');
    expect(html).toContain('data-act="open-conversation" data-id="conv-1"');
  });

  it('删除态保留恢复入口，隐藏不可执行的修改与重复删除入口', () => {
    const html = renderDetail({ ...BASE, status: 'deleted' });
    expect(html).toContain('data-action="restore"');
    expect(html).not.toContain('data-act="edit-asset"');
    expect(html).not.toContain('data-action="delete"');
    expect(html).toContain('data-action="purge"');
  });
});

describe('采用回执读取恢复', () => {
  it('失败后保留失败态，强制重试成功才显示真实回执', async () => {
    let attempts = 0;
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke: async (channel: string) => {
          if (channel !== 'recall.assets.adoptionReceipts') return { ok: true };
          attempts += 1;
          if (attempts === 1) throw new Error('offline');
          return { ok: true, receipts: [{ status: 'applied', id: 'receipt-1' }] };
        },
      },
    });

    await ns.loadAdoptionReceipts(BASE.id);
    expect(store.adoptionReceipts.failed).toBe(true);
    expect(store.adoptionReceipts.items).toHaveLength(0);

    await ns.loadAdoptionReceipts(BASE.id, true);
    expect(store.adoptionReceipts.failed).toBe(false);
    expect(store.adoptionReceipts.items).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe('版本链读取恢复（r3）', () => {
  it('失败后保留失败态，强制重试成功才显示真实版本链', async () => {
    let attempts = 0;
    const { ns, store } = loadCognitionAssets({}, {}, {
      cogseed: {
        invoke: async (channel: string) => {
          if (channel !== 'recall.assets.versions.list') return { ok: true };
          attempts += 1;
          if (attempts === 1) throw new Error('offline');
          return {
            ok: true,
            versions: [{ assetId: BASE.id, version: '1', at: '2026-09-14T01:00:00Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [] } }],
            usage: [], audit: [], frozen: [],
          };
        },
      },
    });

    await ns.loadAssetVersions(BASE.id);
    expect(store.assetVersions.failed).toBe(true);
    expect(store.assetVersions.versions).toHaveLength(0);

    // 不带 force 的重调被失败态缓存判重挡掉（无网络往返）——force 是唯一恢复路径。
    await ns.loadAssetVersions(BASE.id);
    expect(attempts).toBe(1);

    await ns.loadAssetVersions(BASE.id, true);
    expect(store.assetVersions.failed).toBe(false);
    expect(store.assetVersions.versions).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('失败态渲染「版本记录暂不可用」+ 重试按钮，不与空态同形', () => {
    const failed = renderDetail(BASE, {
      assetVersions: { assetId: BASE.id, versions: [], usage: [], audit: [], frozen: [], failed: true },
    });
    expect(failed).toContain('版本记录暂不可用');
    expect(failed).toContain('data-act="asset-versions-retry"');
    // 失败文案不伪装成空态（无「选用此版」等版本条目行为入口）。
    expect(failed).not.toContain('选用此版');

    // 成功态照常渲染版本链，不出失败文案。
    const ok = renderDetail(BASE, {
      assetVersions: {
        assetId: BASE.id, usage: [],
        versions: [{ assetId: BASE.id, version: '1', at: '2026-09-14T01:00:00Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [] } }],
      },
    });
    expect(ok).not.toContain('版本记录暂不可用');
    expect(ok).not.toContain('data-act="asset-versions-retry"');
  });
});

describe('经验详情的一致性', () => {
  it('独立经验按上下顺序展示，保留自己的内容和管理语义', () => {
    const html = renderCognition(
      { name: 'overview', experienceId: 'exp-1' },
      { experienceDetail: { experienceId: 'exp-1', loading: false, failed: false, experience: {
        id: 'exp-1', title: '一次复盘经验', body: '先确认预期，再看结果。',
        status: 'active', experienceType: 'lesson', taskType: 'coding', scope: 'coding',
        applicableWhen: ['代码复核'], forbiddenWhen: [], evidenceRefs: [], history: [],
      } } },
    );
    expect((html.match(/<h1\b/g) || [])).toHaveLength(1);
    expect(html).toContain('ca-experience-detail-grid');
    expect(html).toContain('先确认预期，再看结果。');
    expect(html.indexOf('先确认预期，再看结果。')).toBeLessThan(html.indexOf('代码复核'));
    expect(html).not.toContain('ca-asset-usage-card');
  });
});

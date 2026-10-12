/**
 * 来源解析器（2026-09-25 验收修复 US-603）：候选 / 资产 / 版本 / 使用记录 /
 * KSTAR 五处共用同一份解析结果，因此同一来源必然同名（AC1）；且任何状态下
 * 都不得把内部 id（immediate-* / kse-* / turn-* / cid）当显示名（AC3）。
 *
 * 这里直接断言解析器的输出（data-model.md E4 的解析规则表逐行），呈现层
 * （evidenceChip）另由 recall-source-display / cognition-capture-log 守住。
 */
import { describe, expect, it } from 'vitest';

import { loadCognitionAssets, renderCognition } from './helpers/cognition-renderer';

const RAW_ID_PATTERNS = [/immediate-[0-9a-f]/, /kse-[0-9a-z]/, /turn-\d/, /conv-[0-9a-z]/, /proj-[0-9a-z]/, /aur-[0-9a-z]/, /aa-[0-9a-z]/];

function resolve(state: Record<string, unknown>, ref: Record<string, unknown>) {
  const { ui } = loadCognitionAssets(state);
  return ui.resolveSourceRef(ref);
}

describe('resolveSourceRef：会话来源', () => {
  it('目录命中 → 用目录标题，并给会话回看入口', () => {
    const view = resolve(
      { sources: [{ kind: 'conversation', items: [{ id: 'conv-a', title: '认知资产链路排查', status: 'ready' }] }] },
      { kind: 'conversation', id: 'conv-a' },
    );

    expect(view.state).toBe('available');
    expect(view.name).toBe('认知资产链路排查');
    expect(view.openRoute).toBe('conversation');
    expect(view.openTarget).toBe('conv-a');
  });

  it('目录 100 条窗口外、批量标题口命中 → 同样解析出标题（修复前恒退化成泛称）', () => {
    const view = resolve(
      { sources: [], conversationTitles: { 'conv-out-of-window': '窗口外的会话标题' } },
      { kind: 'conversation', id: 'conv-out-of-window' },
    );

    expect(view.state).toBe('available');
    expect(view.name).toBe('窗口外的会话标题');
    expect(view.openRoute).toBe('conversation');
  });

  it('目录与标题口都查无 → 判失效，不给可点假入口', () => {
    const view = resolve(
      { sources: [], conversationTitles: {}, conversationTitlesSettled: ['conv-gone'] },
      { kind: 'conversation', id: 'conv-gone' },
    );

    expect(view.state).toBe('unavailable');
    expect(view.openRoute).toBe('none');
  });

  it('会话存在但还没起名 → available 且 name 为空（由呈现层给泛称，不谎称失效）', () => {
    const view = resolve(
      { sources: [], conversationTitles: { 'conv-untitled': '' } },
      { kind: 'conversation', id: 'conv-untitled' },
    );

    expect(view.state).toBe('available');
    expect(view.name).toBe('');
  });

  it('ref 自带标题优先于目录（数据层已解析过的最权威）', () => {
    const view = resolve(
      { sources: [{ kind: 'conversation', items: [{ id: 'conv-b', title: '目录里的旧标题', status: 'ready' }] }] },
      { kind: 'conversation', id: 'conv-b', title: '写入时带的标题' },
    );

    expect(view.name).toBe('写入时带的标题');
  });
});

describe('resolveSourceRef：KSTAR 复盘来源', () => {
  const ref = { kind: 'execution', id: 'kse-abc', taxonomyVersion: 1, subtype: 'execution', title: 'KSTAR requirement episode' };

  it('摘要已拉到 → 用任务目标覆盖 ref 上的机器串，并可点回看', () => {
    const view = resolve(
      { kstarSummaries: { 'kse-abc': { id: 'kse-abc', goal: '查认知资产是怎么存的' } }, kstarSummariesSettled: [] },
      ref,
    );

    expect(view.state).toBe('available');
    expect(view.name).toBe('查认知资产是怎么存的');
    expect(view.openRoute).toBe('kstar');
    expect(view.openTarget).toBe('kse-abc');
  });

  it('已结算但无摘要 / 写入时 degraded → 判失效，不可点', () => {
    const gone = resolve({ kstarSummaries: {}, kstarSummariesSettled: ['kse-abc'] }, ref);
    expect(gone.state).toBe('unavailable');
    expect(gone.openRoute).toBe('none');

    const degraded = resolve({ kstarSummaries: {}, kstarSummariesSettled: [] }, { ...ref, degraded: true });
    expect(degraded.state).toBe('unavailable');
  });

  it('还没拉到（未 settled）→ 不判失效：读不到 ≠ 不存在', () => {
    const view = resolve({ kstarSummaries: {}, kstarSummariesSettled: [] }, ref);

    expect(view.state).toBe('available');
    expect(view.name).toBe('');
    expect(view.openRoute).toBe('kstar');
  });
});

describe('resolveSourceRef：其余来源形态', () => {
  it('对话中当场记（immediate-*）→ 独立状态，不算失效', () => {
    const view = resolve({ sources: [] }, { kind: 'conversation', id: 'immediate-9f3a1c' });

    expect(view.state).toBe('immediate');
    expect(view.openRoute).toBe('none');
  });

  it('目录里在但标题未生成 → 整理中', () => {
    const view = resolve(
      { sources: [{ kind: 'conversation', items: [{ id: 'conv-p', title: '', status: 'processing' }] }] },
      { kind: 'conversation', id: 'conv-p' },
    );

    expect(view.state).toBe('processing');
  });

  it('类型可辨但无从核对（turn-* 执行记录）→ 判失效而不是裸 id', () => {
    const view = resolve({ sources: [] }, { kind: 'execution_evaluation', id: 'turn-42' });

    expect(view.state).toBe('unavailable');
    expect(view.name).toBe('');
  });

  it('无 id 无标题 / 空 ref → 判失效，不抛错', () => {
    expect(resolve({ sources: [] }, {}).state).toBe('unavailable');
    expect(resolve({ sources: [] }, { kind: 'conversation' }).state).toBe('unavailable');
  });
});

describe('来源解析的两条铁律', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['目录会话', { sources: [{ kind: 'conversation', items: [{ id: 'conv-a', title: '标题', status: 'ready' }] }] }, { kind: 'conversation', id: 'conv-a' }],
    ['查无会话', { sources: [] }, { kind: 'conversation', id: 'conv-gone' }],
    ['当场记', { sources: [] }, { kind: 'conversation', id: 'immediate-9f3a1c' }],
    ['复盘有摘要', { kstarSummaries: { 'kse-abc': { id: 'kse-abc', goal: '目标' } } }, { kind: 'execution', id: 'kse-abc' }],
    ['复盘查无', { kstarSummariesSettled: ['kse-abc'] }, { kind: 'execution', id: 'kse-abc', degraded: true }],
    ['执行记录', { sources: [] }, { kind: 'execution_evaluation', id: 'turn-42' }],
    ['空 ref', { sources: [] }, {}],
  ];

  it('任何状态下都不把内部 id 当显示名', () => {
    for (const [label, state, ref] of cases) {
      const view = resolve(state, ref);
      for (const pattern of RAW_ID_PATTERNS) {
        expect(view.name, `${label} 的显示名不得是内部 id`).not.toMatch(pattern);
      }
    }
  });

  it('呈现出口（evidenceChip）在任何状态下都不上屏内部 id', () => {
    for (const [label, state, ref] of cases) {
      const { ui } = loadCognitionAssets(state);
      const html = ui.evidenceChip(ref);
      const visible = html.replace(/<[^>]+>/g, ' ');
      for (const pattern of RAW_ID_PATTERNS) {
        expect(visible, `${label} 的 chip 不得上屏内部 id`).not.toMatch(pattern);
      }
      expect(visible, `${label} 的 chip 不得为空`).not.toBe('');
    }
  });

  it('同一来源重复解析结果稳定（五处同名的前提）', () => {
    const state = { sources: [{ kind: 'conversation', items: [{ id: 'conv-a', title: '标题', status: 'ready' }] }] };
    const { ui } = loadCognitionAssets(state);

    expect(ui.resolveSourceRef({ kind: 'conversation', id: 'conv-a' }))
      .toEqual(ui.resolveSourceRef({ kind: 'conversation', id: 'conv-a' }));
  });
});

/* ───────── 五处同名 + 主文案零内部 ID（US-603 AC1/AC2/AC3 的集成面）───────── */

const CONV_REF = { kind: 'conversation', id: 'conv-src-1', taxonomyVersion: 2, subtype: 'session' };
const KSE_REF = { kind: 'execution', id: 'kse-ep-1', taxonomyVersion: 1, subtype: 'execution' };
const SOURCES = [{ kind: 'conversation', items: [{ id: 'conv-src-1', kind: 'conversation', title: '季度复盘讨论', status: 'ready' }] }];

const ASSET = {
  id: 'aa-src',
  title: '来源解析用例资产',
  type: 'rule',
  status: 'active',
  scope: 'general',
  statement: '正文不该出现在来源区。',
  version: '1',
  activeVersion: '1',
  evidenceRefs: [CONV_REF, KSE_REF],
};

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const assetDetailHtml = (extra: Record<string, unknown> = {}) => renderCognition(
  { name: 'overview', assetId: ASSET.id },
  { assets: [ASSET], sources: SOURCES, kstarSummaries: { 'kse-ep-1': { id: 'kse-ep-1', goal: '查认知资产怎么存的' } }, ...extra },
);

const candidateDetailHtml = () => renderCognition(
  { name: 'review', candidateId: 'cand-src' },
  {
    sources: SOURCES,
    kstarSummaries: { 'kse-ep-1': { id: 'kse-ep-1', goal: '查认知资产怎么存的' } },
    candidates: [{
      id: 'cand-src',
      status: 'pending_review',
      capabilities: { canEdit: true, canPromote: true, countsAsPending: true, isSnoozed: false },
      judgment: '保留可追溯的来源说明',
      summary: '来源说明',
      suggestedType: 'rule',
      suggestedScope: 'general',
      sourceRefs: [CONV_REF, KSE_REF],
    }],
  },
);

describe('五处来源同名（US-603 AC1）', () => {
  it('会话来源在资产详情证据块与候选详情里显示同一标题，且都不裸 cid', () => {
    const detail = visibleText(assetDetailHtml());
    const candidate = visibleText(candidateDetailHtml());

    expect(detail).toContain('对话：《季度复盘讨论》');
    expect(candidate).toContain('对话：《季度复盘讨论》');
    expect(detail).not.toContain('conv-src-1');
    expect(candidate).not.toContain('conv-src-1');
  });

  it('KSTAR 来源在两处显示同一任务目标，且都可点回看', () => {
    const detail = assetDetailHtml();
    const candidate = candidateDetailHtml();

    expect(visibleText(detail)).toContain('任务复盘：查认知资产怎么存的');
    expect(visibleText(candidate)).toContain('任务复盘：查认知资产怎么存的');
    expect(detail).toContain('data-act="open-kstar-episode" data-id="kse-ep-1"');
    expect(candidate).toContain('data-act="open-kstar-episode" data-id="kse-ep-1"');
  });

  it('可解析的会话来源给回看入口（点回原对话）', () => {
    const html = assetDetailHtml();

    expect(html).toContain('data-act="open-conversation" data-id="conv-src-1"');
  });

  it('版本证据与使用记录用同一标题（同源同解析）', () => {
    const versionHtml = visibleText(assetDetailHtml({
      assetVersions: {
        assetId: ASSET.id,
        usage: [],
        versions: [{ assetId: ASSET.id, version: '1', at: '2026-09-18T00:00:00.000Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [CONV_REF] } }],
      },
      route: { name: 'overview', assetId: ASSET.id, assetVersionId: '1' },
    }));
    const usageHtml = visibleText(assetDetailHtml({
      proofs: [{ id: 'p-1', kind: 'projection_confirmed', occurredAt: '2026-09-18T05:00:00.000Z', refs: { assetId: ASSET.id, projectionId: 'proj-1', conversationId: 'conv-src-1' } }],
    }));

    expect(versionHtml).toContain('对话：《季度复盘讨论》');
    expect(usageHtml).toContain('对话：《季度复盘讨论》');
  });
});

describe('主文案零内部 ID（US-603 AC3 / SC-003）', () => {
  it('资产详情、候选详情、版本块的主要文案都不出现内部 id', () => {
    const surfaces = [
      assetDetailHtml(),
      candidateDetailHtml(),
      assetDetailHtml({
        assetVersions: {
          assetId: ASSET.id,
          usage: [],
          versions: [{ assetId: ASSET.id, version: '1', at: '2026-09-18T00:00:00.000Z', snapshot: { title: 'T', statement: 'S', evidenceRefs: [CONV_REF, KSE_REF] } }],
        },
        route: { name: 'overview', assetId: ASSET.id, assetVersionId: '1' },
      }),
    ];

    for (const html of surfaces) {
      const visible = visibleText(html);
      for (const pattern of RAW_ID_PATTERNS) {
        expect(visible, `可见文案不得出现 ${pattern}`).not.toMatch(pattern);
      }
      expect(visible).not.toContain('kse-ep-1');
      expect(visible).not.toContain('conv-src-1');
    }
  });
});

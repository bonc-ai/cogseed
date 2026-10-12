/**
 * 治理待办分组区（specs/010 T014~T016 渲染面；2026-09-28 敏感级/扩权整套删除
 * ＋两页重整后收窄）。
 *
 * 页面级断言（与 cognition-capture-log.test.ts 同构的真实页面装配）：
 *   - 分组只剩 冲突 → 其他（扩权/缺边界/未分级三组已随机制与催办删除），
 *     空组不出标题；
 *   - 各分区的行渲染读模型给的动作（渲染层不自判）：冲突选边、巡检选边/合并；
 *   - 主进程尚未同步收窄时，历史残留的敏感级/催办 kind 落 other 兜底标题与
 *     扁平行——不出现定级控件、扩权钮、补条件表单（枚举收窄的双侧同步锚点）；
 *   - 降级路径逐字退回扁平清单；空态恰一处；不出现裸动作名。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const globalScope = globalThis as unknown as Record<string, unknown>;

let cogAssets: Record<string, unknown> | null = null;
let domRoot: { innerHTML: string } | null = null;

function ensureModule(): { cogAssets: Record<string, unknown>; domRoot: { innerHTML: string } } {
  if (cogAssets && domRoot) return { cogAssets, domRoot };
  const T = (key: string, fallbackOrVars?: unknown, maybeVars?: Record<string, string>) => {
    const vars = typeof fallbackOrVars === 'string' ? maybeVars : fallbackOrVars;
    let text = key;
    const locales = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
    if (locales[key] !== undefined) text = String(locales[key]);
    else if (typeof fallbackOrVars === 'string') text = fallbackOrVars;
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars as Record<string, string>)) {
        text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), value);
      }
    }
    return text;
  };
  cogAssets = {
    T, esc: (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    fmtDate: () => '2026/09/26 03:00',
    TABS: [
      { id: 'review', titleKey: 'cognition.tab_review', title: '待我处理' },
      { id: 'overview', titleKey: 'cognition.tab_overview', title: '我的认知' },
      { id: 'organize', titleKey: 'cognition.tab_organize', title: '整理' },
    ],
    stats: () => ({ confirmed: 0, pending: 0, validated: 0, transferOk: 0, sourceIssues: 0, failedTasks: 0, coveredAssets: 0, proofCount: 0, attention: 0 }),
    store: {
      loaded: true, loading: false, errors: [],
      route: { name: 'review', category: '', assetId: '', candidateId: '', proofEventId: '', captureBucket: '', captureId: '', sourceIssueOpen: '' },
      captures: [], captureSettings: null,
      sources: [], proofs: [], assets: [], candidates: [],
      organizeSettingsOpen: false, organizeListExpanded: true,
    },
  };
  domRoot = { innerHTML: '' };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { uiInput, uiSwitch, uiTextarea } = require('../../src/renderer/modules/ui-form.js');
  const { uiEmptyState } = require('../../src/renderer/modules/ui-empty.js');
  globalScope.window = {
    CogAssets: cogAssets,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiButton: require('../../src/renderer/modules/ui-button.js').uiButton,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiIconButton: require('../../src/renderer/modules/ui-button.js').uiIconButton,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    uiIconHtml: (() => { require('../../src/renderer/modules/icons.js'); return (globalScope as { uiIconHtml?: unknown }).uiIconHtml; })(),
    uiInput, uiSwitch, uiTextarea, uiEmptyState,
  };
  globalScope.document = { getElementById: () => domRoot };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/ui-status.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/ui-page-header.js');
  // 分段控件是 index.html 的静态共享层（设置页「新建议如何保存」等仍用它；
  // 敏感级三档控件已随机制删除，2026-09-28）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/ui-segmented-control.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/vocabulary.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/views.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/review-candidate.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/review-views.js');
  return { cogAssets, domRoot };
}

function renderPage(routeName: string, storePatch: Record<string, unknown>): string {
  const { cogAssets: NS, domRoot: rootEl } = ensureModule();
  Object.assign(NS.store as Record<string, unknown>, storePatch);
  (NS.store as Record<string, unknown>).route = { name: routeName, category: '', assetId: '', candidateId: '', proofEventId: '', captureBucket: '', captureId: '', sourceIssueOpen: '' };
  rootEl.innerHTML = '';
  (NS.render as () => void)();
  return rootEl.innerHTML;
}

const CONFLICT_ITEM = {
  id: 'conflict:cand-1', kind: 'classification_conflict', urgency: 'confirm',
  title: '同一句话', candidateId: 'cand-1', detail: 'fact / rule', actions: ['claim', 'reject', 'defer'],
};
// 2026-09-28 敏感级机制删除后，历史残留形态（主进程分组收窄前的旧数据）：
// 用来钉「渲染层不再给这些 kind 专属控件，落 other 兜底与扁平行」。
const STALE_SENSITIVITY_ITEMS = [
  { id: 'sensitivity-up:aa-1', kind: 'sensitivity_escalated', urgency: 'confirm',
    title: '被提级的资产', assetId: 'aa-1', detail: 'L1 → L2', actions: ['accept', 'reject'] },
  { id: 'sensitivity:aa-3', kind: 'sensitivity_unclassified', urgency: 'confirm', title: '资产三', assetId: 'aa-3', actions: ['classify'] },
  { id: 'rule-boundary:aa-2', kind: 'rule_boundary_missing', urgency: 'low_disturbance',
    title: '缺边界的规则', assetId: 'aa-2', boundary: { applicableWhen: ['发布窗口内'], forbiddenWhen: [] }, actions: ['set_boundary'] },
];
const OTHER_ITEM = {
  id: 'candidate:cand-9', kind: 'candidate_pending_review', urgency: 'low_disturbance',
  title: '普通待确认候选', candidateId: 'cand-9', actions: ['accept', 'reject', 'defer'],
};
const PAIR_FINDING = {
  id: 'inspection:dup:aa-5+aa-6', kind: 'inspection_finding', urgency: 'low_disturbance',
  title: '很像的两条', assetId: 'aa-5', assetIds: ['aa-5', 'aa-6'], findingCategory: 'duplicate',
  detail: '这两条看字面很像（97%）', actions: ['keep', 'merge', 'reject', 'defer'],
};

/** 与主进程 groupCognitionInbox 同构的分组夹具（顺序、折叠行为一致）。 */
function groupsFixture(_items: Array<Record<string, unknown>>) {
  return [
    { category: 'conflict', titleKey: 'cognition.inbox_group_conflict', items: [CONFLICT_ITEM, PAIR_FINDING], count: 2, total: 3 },
    { category: 'other', titleKey: 'cognition.inbox_group_other', items: [OTHER_ITEM], count: 1, total: 1 },
  ].filter((group) => group.items.length);
}

describe('治理待办分组区（specs/010 T014~T016；2026-09-28 收窄后）', () => {
  it('urgency 分区内分组保持主进程定序（冲突 → 其他）、空组不出标题', () => {
    // specs/018 v2（2026-09-26 真机重做）：分区按后端 urgency（要你拍板 /
    // 低打扰），组名降为区内小节；主进程组序在区内保持。敏感级三组删除后
    // 只剩冲突与其他。
    const items = [CONFLICT_ITEM, PAIR_FINDING, OTHER_ITEM];
    const html = renderPage('review', { inbox: items, inboxGroups: groupsFixture(items) });
    const at = (label: string) => html.indexOf(label);
    for (const label of ['冲突与重复', '其他待处理']) {
      expect(at(label)).toBeGreaterThan(-1);
    }
    // 已删除的敏感级/催办组名不再出现。
    for (const gone of ['能去的地方变多了', '什么时候用、什么时候别用（还没写）', '还没定敏感档位']) {
      expect(at(gone)).toBe(-1);
    }
    // 「要你拍板」区在前，「低打扰」折叠区在后（其他组 low_disturbance 行落里面）。
    expect(at('要你拍板')).toBeGreaterThan(-1);
    const lowAt = html.indexOf('fold-low');
    expect(lowAt).toBeGreaterThan(at('冲突与重复'));
    expect(html.indexOf('其他待处理', lowAt)).toBeGreaterThan(lowAt);
    // 分组计数 = 本拆分区条目数：confirm 区冲突组只有候选冲突 1 条（巡检
    // pair 是 low_disturbance，落低打扰区的冲突组）——未分级组「显示 total」
    // 的特判已随分级待办删除，组内不再引用 group.total。
    expect(html).toMatch(/冲突与重复<span class="note">1<\/span>/);
    expect(html.indexOf('冲突与重复', lowAt)).toBeGreaterThan(lowAt);
  });

  it('冲突行：候选侧 claim；巡检 pair 侧 keep/merge 携带 anchor 与另一方', () => {
    const items = [CONFLICT_ITEM, PAIR_FINDING];
    const html = renderPage('review', { inbox: items, inboxGroups: groupsFixture(items) });
    expect(html).toContain('data-act="inbox-conflict-claim" data-id="conflict:cand-1"');
    expect(html).toContain('data-act="inbox-inspection-keep" data-id="inspection:dup:aa-5+aa-6" data-anchor="aa-5" data-target="aa-6"');
    expect(html).toContain('data-act="inbox-inspection-merge" data-id="inspection:dup:aa-5+aa-6" data-anchor="aa-5" data-target="aa-6"');
  });

  it('敏感级残留 kind 落 other 兜底与扁平行：无定级控件、无扩权钮、无补条件表单', () => {
    // 主进程分组枚举收窄前的历史残留（深探 F33：枚举收窄需双侧同步）——
    // 渲染层对认不出的 category 落「其他待处理」标题，对已删除机制的 kind
    // 走扁平行（有动作给动作钮，没有给资产详情落点），不再渲染任何专属控件。
    const groups = [
      { category: 'escalation', titleKey: 'cognition.inbox_group_escalation', items: [STALE_SENSITIVITY_ITEMS[0], STALE_SENSITIVITY_ITEMS[1]], count: 2, total: 2 },
      { category: 'boundary', titleKey: 'cognition.inbox_group_boundary', items: [STALE_SENSITIVITY_ITEMS[2]], count: 1, total: 1 },
    ];
    const html = renderPage('review', { inbox: STALE_SENSITIVITY_ITEMS, inboxGroups: groups });
    // 组标题兜底成「其他待处理」（旧组名键已从渲染层字典删除）。
    expect((html.match(/其他待处理/g) || []).length).toBe(2);
    expect(html).not.toContain('能去的地方变多了');
    expect(html).not.toContain('什么时候用、什么时候别用（还没写）');
    // 专属控件与动作全部不再渲染。缺边界行例外（2026-09-29 A1 恢复）：
    // specs/010 T028 的「就地补条件」表单回来了——后端处置链与 boundary
    // 预填字段一直都在，此前只删了前端表单，按钮裸出工程词且点了必报错。
    expect(html).not.toContain('data-act="inbox-classify-level"');
    expect(html).not.toContain('data-act="inbox-classify-apply"');
    expect(html).not.toContain('data-act="inbox-classify-batch"');
    expect(html).not.toContain('data-act="inbox-escalation-accept"');
    expect(html).not.toContain('data-act="inbox-escalation-reject"');
    expect(html).toContain('data-inbox-boundary-form');
    // 表单三件：适用/禁用两个输入（预填当前条件）+ 保存边界按钮；按钮文案
    // 是人话，不是裸动作名 set_boundary。
    expect(html).toContain('data-f="boundary-applicable"');
    expect(html).toContain('data-f="boundary-forbidden"');
    expect(html).toContain('data-act="inbox-boundary-save" data-id="rule-boundary:aa-2"');
    expect(html).toContain('发布窗口内');
    expect(html).not.toContain('>set_boundary<');
    expect(html).not.toContain('ui-segmented-control');
    expect(html).not.toContain('批量定级');
  });

  it('不出现裸动作名（label 表全覆盖，labels[action]||action 的兜底不触发）', () => {
    // 2026-09-29 D6：fixture 加入缺边界行——此前防线测试的 items 不含
    // rule_boundary_missing，set_boundary 裸词按钮若回流不会被抓到。
    const items = [CONFLICT_ITEM, PAIR_FINDING, OTHER_ITEM, STALE_SENSITIVITY_ITEMS[2]];
    const groups = [
      { category: 'conflict', titleKey: 'cognition.inbox_group_conflict', items: [CONFLICT_ITEM, PAIR_FINDING], count: 2, total: 3 },
      { category: 'other', titleKey: 'cognition.inbox_group_other', items: [OTHER_ITEM, STALE_SENSITIVITY_ITEMS[2]], count: 2, total: 2 },
    ];
    const html = renderPage('review', { inbox: items, inboxGroups: groups });
    for (const bare of ['>claim<', '>keep<', '>merge<', '>classify<', '>set_boundary<', '>accept<', '>reject<']) {
      expect(html).not.toContain(bare);
    }
  });

  it('降级路径：groups 缺失时逐字退回扁平清单（既有断言的锚点行为）', () => {
    const html = renderPage('review', { inbox: [OTHER_ITEM], inboxGroups: null });
    expect(html).toContain('待确认清单');
    expect(html).toContain('data-act="inbox-resolve" data-id="candidate:cand-9" data-action="accept"');
    expect(html).not.toContain('冲突与重复');
  });

  it('空态恰一处：没有待办时只出现一个空态说明，没有空分组标题', () => {
    const html = renderPage('review', { inbox: [], inboxGroups: [] });
    expect((html.match(/没有需要你确认的事项。/g) || []).length).toBe(1);
    expect(html).not.toContain('冲突与重复');
    expect(html).not.toContain('其他待处理');
  });
});

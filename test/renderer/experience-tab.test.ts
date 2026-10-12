import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCognition, loadCognitionAssets } from './helpers/cognition-renderer';

/**
 * 「经验」页签（specs/016 US-801 T019 / US-803 T029）：
 *  1. 分组渲染（lesson → workflow → gap → uncategorized 固定顺序，空组不摆）；
 *  2. 来源任务可点（复用 open-kstar-episode，不新建跳转机制）；
 *  3. 零裸控件、零内联 SVG（shared-ui-adoption-guard 的同款源码口径，落在
 *     经验区函数块上——uiButton 产出的 button 是共享组件，不算裸控件）；
 *  4. 资产条目零混入（SC-001 渲染面：经验视图不读资产列表）；
 *  5. 深链 experienceId 可回详情；详情含预期/实际/适用范围/验证状态与四个
 *     管理动作（终态无管理出口）；
 *  6. 迁移区如实呈现「已迁/未迁/原因」（预览计数、逐条入口、跳过理由码翻人话）。
 */

const viewsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/cognition-assets/views.js'),
  'utf8',
);

/** 抽出 views.js 里经验目录视图段的源码（分组注释到下一区块横幅之前；
 *  2026-09-29 拆分：「视图：待我处理」横幅随 viewReview 迁至 review-views.js，
 *  终点锚改为原顺序中紧随其后的 KSTAR 复盘历史区块横幅，切片范围不变）。 */
function experienceViewsBlock(): string {
  const start = viewsSource.indexOf('视图：经验目录');
  const end = viewsSource.indexOf('KSTAR 复盘历史区块', start);
  if (start < 0 || end < 0) throw new Error('experience views block not found');
  return viewsSource.slice(start, end);
}

const experienceItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'exp-t0001',
  title: '类型断言要前置到合并前检查',
  experienceType: 'lesson',
  taskType: 'code',
  scope: 'code',
  outcome: 'worse_than_expected',
  verificationState: 'confirmed',
  status: 'active',
  sourceTask: { episodeId: 'kse-t0001', goal: '把 X 模块的测试补上', taskStatus: 'completed' },
  updatedAt: '2026-09-25T10:00:00.000Z',
  ...overrides,
});

const loadedExperiences = (items: Array<Record<string, unknown>>) => ({
  items,
  loading: false,
  failed: false,
  stale: false,
});

describe('经验入口：「我的认知」下的分类档（specs/017 整改一，原 T019 页签断言改写）', () => {
  it('顶层页签是五个（无「经验」），经验收编为「我的认知」分类档；旧深链 name:experiences 归一化', () => {
    const html = renderCognition({ name: 'experiences' }, { experiences: loadedExperiences([]) });
    const ids = [...html.matchAll(/class="ca-tab[^"]*" data-act="tab" data-id="([a-z-]+)"/g)].map((m) => m[1]);
    // specs/018 + 树恢复 + 2026-09-27 定序:六页签=认知树/我的认知/关于我/待我处理/系统活动/整理设置。
    expect(ids).toEqual(['tree', 'overview', 'ontology', 'review', 'activity', 'settings']);
    expect(html).not.toContain('data-act="tab" data-id="experiences"');
    // 旧深链 { name: 'experiences' } 归一到「我的认知」：经验档选中、目录在页面内。
    expect(html).toContain('data-act="filter-cat" data-id="experiences"');
    expect(html).toContain('经验目录');
    // KSTAR 独立筛选档退役（出身徽章与「KSTAR 任务复盘」证据组保留，
    // 见 cognition-capture-log.test.ts）。
    expect(html).not.toContain('data-act="filter-cat" data-id="kstar"');
  });

  it('按经验类型分组：固定顺序、空组不摆、未知类型兜底进未分类', () => {
    const html = renderCognition({ name: 'experiences' }, {
      experiences: loadedExperiences([
        experienceItem(),
        experienceItem({ id: 'exp-t0002', title: '先写验收再动手', experienceType: 'lesson' }),
        experienceItem({ id: 'exp-t0003', title: '发布清单缺一步回滚', experienceType: 'gap', taskType: 'product' }),
        experienceItem({ id: 'exp-t0004', title: '一条判不出类型的经验', experienceType: 'weird_type' }),
      ]),
    });
    const order = ['可复用经验', '待修正经验', '未分类经验'].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // workflow 组为空：标题不出现，不摆空组。
    expect(html).not.toContain('已验证的工作流程');
    expect((html.match(/data-act="open-experience"/g) || []).length).toBe(4);
  });

  it('行上显示来源任务/任务类型/验证状态；来源可点回看（open-kstar-episode）', () => {
    const html = renderCognition({ name: 'experiences' }, {
      experiences: loadedExperiences([experienceItem()]),
    });
    expect(html).toContain('data-act="open-kstar-episode" data-id="kse-t0001"');
    expect(html).toContain('把 X 模块的测试补上');
    expect(html).toContain('代码类任务');
    expect(html).toContain('已确认');
    expect(html).toContain('比预期差');
    // 终态条目（archived/merged）不进列表。
    const withTerminal = renderCognition({ name: 'experiences' }, {
      experiences: loadedExperiences([
        experienceItem(),
        experienceItem({ id: 'exp-t0005', title: '已归档的经验', status: 'archived' }),
        experienceItem({ id: 'exp-t0006', title: '已并入的经验', status: 'merged' }),
      ]),
    });
    expect(withTerminal).toContain('类型断言要前置到合并前检查');
    expect(withTerminal).not.toContain('已归档的经验');
    expect(withTerminal).not.toContain('已并入的经验');
    expect((withTerminal.match(/data-act="open-experience"/g) || []).length).toBe(1);
  });

  it('载入中 / 读取失败 / 空态三态分开（读不到 ≠ 没有）', () => {
    const loading = renderCognition({ name: 'experiences' }, { experiences: { items: [], loading: true, failed: false, stale: false } });
    expect(loading).toContain('正在读取经验目录…');
    const failed = renderCognition({ name: 'experiences' }, { experiences: { items: [], loading: false, failed: true, stale: false } });
    expect(failed).toContain('经验目录读取失败');
    expect(failed).toContain('data-act="refresh"');
    const emptyState = renderCognition({ name: 'experiences' }, { experiences: loadedExperiences([]) });
    expect(emptyState).toContain('还没有沉淀下来的经验');
  });

  it('资产条目零混入：经验视图不读资产列表，行上无资产跳转（SC-001 渲染面）', () => {
    const block = experienceViewsBlock();
    expect(block).not.toContain('S.assets');
    const html = renderCognition({ name: 'experiences' }, {
      assets: [{ id: 'aa-mix0001', title: '一条不应出现的资产', type: 'rule', status: 'active' }],
      experiences: loadedExperiences([experienceItem()]),
    });
    expect(html).not.toContain('一条不应出现的资产');
    expect(html).not.toContain('data-go-asset');
  });

  it('经验区源码零裸控件、零内联 SVG（与 shared-ui-adoption-guard 同一口径）', () => {
    const block = experienceViewsBlock();
    expect((block.match(/<(?:button|input|textarea|select)\b/gi) || []).length).toBe(0);
    expect((block.match(/<svg\b/gi) || []).length).toBe(0);
    // 渲染产物里的 button 只能来自共享 uiButton（带 ui-button 类）。
    const html = renderCognition({ name: 'experiences' }, { experiences: loadedExperiences([experienceItem()]) });
    for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
      expect(match[1]).toContain('ui-button');
    }
  });
});

describe('经验详情：深链与管理动作（T019/T029）', () => {
  const detailExperience = {
    ...experienceItem(),
    body: '合并冲突的类型断言会掩盖运行时错误：先补齐测试再合并。',
    expected: '断言失败前测试全绿',
    actual: '合并后运行时抛错，测试没有拦住',
    applicableWhen: ['处理代码类任务时'],
    forbiddenWhen: ['只读巡检任务'],
    verification: { state: 'confirmed', outcome: 'worse_than_expected', deltaR: -0.4, confidence: 0.82 },
    evidenceRefs: [{ kind: 'execution', id: 'kse-t0001' }, { kind: 'conversation', id: 'conv-t0001', title: '那场合并讨论' }],
    mergedFrom: [{ id: 'exp-t0009', title: '早先的重复经验', mergedAt: '2026-09-24T08:00:00.000Z' }],
    history: [
      { at: '2026-09-25T09:00:00.000Z', actor: 'user', action: 'type_changed', from: 'gap', to: 'lesson', reason: '看错了，这是教训' },
      { at: '2026-09-25T10:00:00.000Z', actor: 'user', action: 'paused' },
    ],
    createdAt: '2026-09-24T08:00:00.000Z',
  };
  const detailState = {
    experiences: loadedExperiences([
      experienceItem(),
      experienceItem({ id: 'exp-t0002', title: '同类型的另一条经验' }),
      experienceItem({ id: 'exp-t0003', title: '不同类型的经验', experienceType: 'workflow' }),
    ]),
    experienceDetail: { experienceId: 'exp-t0001', experience: detailExperience, loading: false, failed: false },
  };

  it('深链 experienceId 可回详情：正文/预期/实际/适用范围/验证状态/证据/台账齐全', () => {
    const html = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, detailState);
    expect(html).toContain('合并冲突的类型断言会掩盖运行时错误');
    expect(html).toContain('当时的预期');
    expect(html).toContain('实际发生');
    expect(html).toContain('处理代码类任务时');
    expect(html).toContain('只读巡检任务');
    expect(html).toContain('验证状态');
    // deltaR/confidence 不上屏（specs/015 对 views.js 的源码级墓碑）：
    // 验证状态只呈现状态与结果，不渲染内部度量字段。
    expect(html).not.toContain('deltaR');
    expect(html).not.toContain('-0.4');
    // 证据走唯一呈现出口 evidenceChip：会话名可读、复盘 chip 带 kse 深链。
    expect(html).toContain('那场合并讨论');
    expect(html).toContain('data-act="open-kstar-episode" data-id="kse-t0001"');
    // 台账：动作人话 + from → to + 依据。
    expect(html).toContain('类型调整');
    expect(html).toContain('gap → lesson');
    expect(html).toContain('看错了，这是教训');
  });

  it('详情挂四个管理动作（T029）：暂停/类型调整/合并目标/归档，同类型才可并', () => {
    const html = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, detailState);
    expect(html).toContain('data-act="experience-status-toggle"');
    expect(html).toContain('data-action="pause"');
    // 类型调整：给出其余三类的入口（当前 lesson 不重复给）。
    const setType = [...html.matchAll(/data-act="experience-set-type" data-id="exp-t0001" data-type="([a-z]+)"/g)].map((m) => m[1]);
    expect(setType.sort()).toEqual(['gap', 'uncategorized', 'workflow']);
    // 合并目标只列同类型（exp-t0002），不同类型（exp-t0003）不出现。
    expect(html).toContain('同类型的另一条经验');
    expect(html).toMatch(/data-act="experience-merge" data-id="exp-t0001" data-target="exp-t0002"/);
    expect(html).not.toContain('data-target="exp-t0003"');
    expect(html).toContain('data-act="experience-archive"');
  });

  it('终态详情无管理出口：merged 给去向跳转，archived 给口径说明', () => {
    const merged = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, {
      ...detailState,
      experienceDetail: {
        experienceId: 'exp-t0001',
        experience: { ...detailExperience, status: 'merged', mergedIntoExperienceId: 'exp-t0002' },
        loading: false,
        failed: false,
      },
    });
    expect(merged).not.toContain('data-act="experience-status-toggle"');
    expect(merged).not.toContain('data-act="experience-archive"');
    expect(merged).toContain('已并入');
    expect(merged).toContain('data-act="open-experience" data-id="exp-t0002"');

    const archived = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, {
      ...detailState,
      experienceDetail: {
        experienceId: 'exp-t0001',
        experience: { ...detailExperience, status: 'archived' },
        loading: false,
        failed: false,
      },
    });
    expect(archived).not.toContain('data-act="experience-archive"');
    expect(archived).toContain('已归档清理');
  });

  it('详情读取中 / 失败两态分开，不冒充空内容', () => {
    const loading = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, {
      experienceDetail: { experienceId: 'exp-t0001', loading: true, failed: false },
    });
    expect(loading).toContain('正在读取这条经验…');
    const failed = renderCognition({ name: 'experiences', experienceId: 'exp-t0001' }, {
      experienceDetail: { experienceId: 'exp-t0001', experience: null, loading: false, failed: true },
    });
    expect(failed).toContain('这条经验读取失败或已不存在');
  });
});

describe('存量迁移区（T020）', () => {
  const preview = {
    scanned: 120,
    migratable: 2,
    skipped: 118,
    items: [
      { assetId: 'aa-mig0001', title: '旧经验资产一', assetType: 'rule', status: 'active', experienceTypeGuess: 'lesson', frozenProjections: 2 },
      { assetId: 'aa-mig0002', title: '旧经验资产二', assetType: 'skill_method', status: 'paused', experienceTypeGuess: 'gap', frozenProjections: 0 },
    ],
    skippedReasons: [
      { reason: 'no_kstar_provenance', count: 108 },
      { reason: 'capture_line', count: 10 },
    ],
  };

  it('未扫描时给扫描入口；预览后给计数、逐条入口与跳过理由人话', () => {
    const idle = renderCognition({ name: 'experiences' }, { experiences: loadedExperiences([]) });
    expect(idle).toContain('data-act="experience-migration-preview"');

    const html = renderCognition({ name: 'experiences' }, {
      experiences: loadedExperiences([]),
      experienceMigration: { preview, previewLoading: false, previewFailed: false, lastRun: null },
    });
    expect(html).toContain('扫描 120 条：可迁 2 条，跳过 118 条');
    expect(html).toContain('没有任务复盘来源标记');
    expect(html).toContain('× 108');
    expect(html).toContain('会话整理线产出');
    expect(html).toMatch(/data-act="experience-migration-run" data-asset="aa-mig0001"/);
    expect(html).toContain('data-assets="aa-mig0001,aa-mig0002"');
    expect(html).toContain('将冻结 2 处历史引用');
    expect(html).toContain('data-act="experience-migration-status"');
  });

  it('上次结果如实列出：已迁/跳过/失败逐条带原因人话（标题可核对）', () => {
    const html = renderCognition({ name: 'experiences' }, {
      experiences: loadedExperiences([]),
      experienceMigration: {
        preview,
        previewLoading: false,
        previewFailed: false,
        lastRun: {
          migrationId: 'exm-1', status: 'done', migrated: 1, skipped: 1, failed: 0,
          details: [
            { assetId: 'aa-mig0001', experienceId: 'exp-new1', reason: 'ok' },
            { assetId: 'aa-mig0002', reason: 'already_migrated' },
          ],
        },
      },
    });
    expect(html).toContain('上次迁移：已迁 1 条，跳过 1 条，失败 0 条');
    expect(html).toContain('旧经验资产一');
    expect(html).toContain('已迁入');
    expect(html).toContain('此前已迁移过');
  });
});

describe('经验枚举纯函数（R6：未知值不崩、有兜底、不裸出内部枚举）', () => {
  it('分组/类型/任务类型/验证状态/迁移理由码的兜底映射', async () => {
    const { ns } = loadCognitionAssets({}, {});
    expect(ns.experience.groupKey('lesson')).toBe('lesson');
    expect(ns.experience.groupKey('weird')).toBe('uncategorized');
    expect(ns.experience.groupKey(undefined)).toBe('uncategorized');
    expect(ns.experience.typeLabel('workflow')).toBe('已验证的工作流程');
    expect(ns.experience.typeLabel('weird')).toBe('未分类经验');
    expect(ns.experience.taskTypeLabel('report')).toBe('报告类任务');
    expect(ns.experience.taskTypeLabel('nope')).toBe('未知任务类型');
    expect(ns.experience.verificationLabel('confirmed')).toBe('已确认');
    expect(ns.experience.verificationLabel('nope')).toBe('验证状态未知');
    expect(ns.experience.migrationReasonText('ok')).toBe('已迁入');
    expect(ns.experience.migrationReasonText('no_kstar_provenance')).toBe('没有任务复盘来源标记（不是任务复盘形成的）');
    expect(ns.experience.migrationReasonText('weird_code')).toBe('不符合迁移条件');
    expect(ns.experience.statusLabel('merged')).toBe('已并入');
    expect(ns.experience.statusLabel('nope')).toBe('状态未知');
  });
});

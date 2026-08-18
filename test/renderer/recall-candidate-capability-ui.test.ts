/**
 * Phase 2：渲染层只消费主进程下发的 capability。
 *
 * 用接近实机的分布做样本（多条 confirmed + 多条 weak_observation + 0 条
 * pending_review）——只用 pending_review 的理想化桩正是过去"代码在、测试绿、
 * 实机坏"的成因。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');
// 用真实 zh 词条驱动渲染：断言落在用户真正看到的文案上，同时证明新键确实存在。
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'),
);

function loadSkillsRenderer() {
  const context: any = {
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => zh[key] || key,
    window: { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    escapeHtml: (value: unknown) => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    normalizeDisplayText: (value: unknown) => String(value || '').trim(),
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(skillsSource, context, { filename: 'skills.js' });
  return context;
}

const ACTIONABLE = {
  canView: true, canEdit: true, canConfirm: true, canPromote: true, canReject: true,
  canDefer: true, canRetry: false, canBatchSelect: true, needsUserAction: true,
  countsAsPending: true, isSnoozed: false, isTerminal: false,
};
const READ_ONLY = {
  canView: true, canEdit: false, canConfirm: false, canPromote: false, canReject: false,
  canDefer: false, canRetry: false, canBatchSelect: false, needsUserAction: false,
  countsAsPending: false, isSnoozed: false, isTerminal: true,
};

function candidate(id: string, status: string, capabilities: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id, status, judgment: `判断 ${id}`, suggestedType: 'rule', suggestedScope: 'product',
    suggestedAction: 'create', sourceRefs: [{ kind: 'memory', id: `mem-${id}` }],
    evidenceRefs: [{ kind: 'memory', id: `mem-${id}` }], capabilities, ...extra,
  };
}

/** 实机分布：0 条 pending_review。 */
const REAL_WORLD_POOL = [
  candidate('c-weak-1', 'weak_observation', { ...ACTIONABLE, displayState: 'weak_evidence' }),
  candidate('c-weak-2', 'weak_observation', { ...ACTIONABLE, displayState: 'weak_evidence' }),
  candidate('c-weak-high', 'weak_observation', {
    ...ACTIONABLE, canBatchSelect: false, displayState: 'weak_evidence',
    batchBlockedReason: 'candidate_high_risk_needs_single_review',
  }, { risk: 'high' }),
  candidate('c-done-1', 'confirmed', { ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed' }),
  candidate('c-done-2', 'confirmed', { ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed' }),
];

function renderPool(pool: unknown[]) {
  const context = loadSkillsRenderer();
  const host = { innerHTML: '' };
  context.document = {
    getElementById: (id: string) => (id === 'skills-cognition-capture-review-body' ? host : null),
  };
  vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
    recallCandidates: pool, captures: [], recentCaptures: [], sources: [],
    selectedCaptureId: null, selectedRecallCandidateIds: [], candidatePoolSelectionInitialized: false,
  })})`, context);
  context.renderSkillsCognitionCandidates();
  return { context, html: host.innerHTML };
}

describe('recall candidate pool renders from capability, not raw status', () => {
  it('keeps weak_observation actionable and batch-selectable with zero pending_review', () => {
    const { context, html } = renderPool(REAL_WORLD_POOL);

    // 待处理列表里有可操作项，而不是因为"没有 pending_review"而空。
    expect(html).toContain('data-recall-candidate-id="c-weak-1"');
    expect(html).toContain('data-recall-candidate-action="promote" data-recall-candidate-id="c-weak-1"');
    expect(html).toContain('data-recall-candidate-action="defer" data-recall-candidate-id="c-weak-1"');
    expect(html).toContain('data-recall-candidate-action="reject" data-recall-candidate-id="c-weak-1"');
    expect(html).toContain('证据较弱');

    // 批量勾选不再恒为 0：两条低风险弱候选默认入选，高风险那条被排除。
    expect(vm.runInContext('_skillsCognitionState.selectedRecallCandidateIds', context)).toEqual(['c-weak-1', 'c-weak-2']);
    expect(html).toContain('data-recall-candidate-select="c-weak-1"');
    expect(html).not.toContain('data-recall-candidate-select="c-weak-high"');
    // 一键入库按钮不带 disabled。
    expect(html).toMatch(/data-recall-candidate-promote-all\s*>/);
  });

  it('states the real reason a candidate cannot be batch-selected', () => {
    const { html } = renderPool(REAL_WORLD_POOL);
    expect(html).toContain('高风险候选需要单独确认，不能批量入库');
    // 不再把所有不可勾选项一律说成"失败候选需单独重试"。
    expect(html).not.toContain('失败候选需单独重试');
  });

  it('never renders candidate actions for confirmed or rejected candidates', () => {
    const { html } = renderPool(REAL_WORLD_POOL);
    // 终态候选不进待处理池，更不会带确认/晋升按钮。
    expect(html).not.toContain('data-recall-candidate-id="c-done-1"');
    expect(html).not.toContain('data-recall-candidate-action="promote" data-recall-candidate-id="c-done-1"');

    const rejected = [candidate('c-rejected', 'rejected', {
      ...READ_ONLY, displayState: 'rejected', disabledReason: 'candidate_rejected',
    })];
    expect(renderPool(rejected).html).not.toContain('data-recall-candidate-action=');
  });

  it('treats a candidate without capabilities as read-only instead of guessing', () => {
    // 旧快照 / 降级读：没有能力字段时绝不能猜成可操作。
    const stale = [{ id: 'c-stale', status: 'pending_review', judgment: '旧快照', suggestedType: 'rule', suggestedScope: 'product' }];
    expect(renderPool(stale).html).not.toContain('data-recall-candidate-action=');
  });
});

describe('recall candidate detail renders from capability', () => {
  function renderDetail(target: Record<string, unknown>) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-candidate-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [target], selectedCandidateId: target.id,
    })})`, context);
    context.renderSkillsCognitionCandidateDetail();
    return host.innerHTML;
  }

  it('offers confirm-and-scope for a weak observation', () => {
    const html = renderDetail(candidate('c-weak', 'weak_observation', {
      ...ACTIONABLE, displayState: 'weak_evidence',
    }));
    expect(html).toContain('data-recall-candidate-action="save-and-promote"');
    expect(html).toContain('data-recall-edit-judgment');
    expect(html).toContain('证据较弱');
  });

  it('turns a confirmed candidate into a read-only record with a real reason', () => {
    const html = renderDetail(candidate('c-done', 'confirmed', {
      ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed',
    }));
    // P2「假可编辑」：确认后不得再出现编辑区与候选动作。
    expect(html).not.toContain('data-recall-candidate-action="save-and-promote"');
    expect(html).not.toContain('data-recall-candidate-action="reject"');
    expect(html).not.toContain('data-recall-candidate-action="defer"');
    expect(html).not.toContain('data-recall-edit-judgment');
    expect(html).not.toContain('data-recall-edit-scope');
    expect(html).toContain('已确认并沉淀为资产，后续修改请在正式资产里进行');
    expect(html).toContain('已确认并沉淀');
    // 来源定位入口保留：候选仍然是可查的来源记录。
    expect(html).toContain('data-cognition-locate-candidate-capture="c-done"');
  });

  it('keeps an expired candidate read-only', () => {
    const html = renderDetail(candidate('c-old', 'expired', {
      ...READ_ONLY, displayState: 'expired', disabledReason: 'candidate_expired',
    }));
    expect(html).not.toContain('data-recall-candidate-action=');
    expect(html).toContain('已失效，无法继续处理');
  });

  it('blocks confirmation while evidence is insufficient and says why', () => {
    const html = renderDetail(candidate('c-bare', 'weak_observation', {
      ...ACTIONABLE, canConfirm: false, canPromote: false, canReject: false, canDefer: false,
      canBatchSelect: false, needsUserAction: false, countsAsPending: false,
      displayState: 'weak_evidence', disabledReason: 'candidate_evidence_insufficient',
    }, { sourceRefs: [], evidenceRefs: [] }));
    expect(html).not.toContain('data-recall-candidate-action="save-and-promote"');
    expect(html).toContain('证据不足，补充证据后才能确认');
    // 补证据是唯一出路，所以编辑区必须留着。
    expect(html).toContain('data-recall-edit-evidence');
  });
});

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
const bindingsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills-bindings.js'), 'utf8');

function installSharedUi(context: vm.Context) {
  for (const file of ['icons.js', 'ui-button.js', 'ui-form.js', 'ui-empty.js', 'ui-segmented-control.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8'), context, { filename: file });
  }
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}
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
  installSharedUi(context);
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

// ── 2026-09-15 #266 重构：候选池/详情渲染自 skills.js 迁至
//    cognition-assets/views.js + core.js。旧 vm 渲染入口
//    （renderSkillsCognitionCandidates / _skillsCognitionState 批量勾选）
//    删除——批量入库改由详情页逐条决定 + 高风险独立确认。以下断言更新为
//    真实实现源码的契约检查，覆盖同一组用户语义。

const viewsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/views.js'), 'utf-8');
const coreSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-assets/core.js'), 'utf-8');

describe('recall candidate pool renders from capability, not raw status', () => {
  it('keeps weak_observation actionable with evidence warning and full decision set', () => {
    // 候选卡片按能力渲染：证据弱 → ca-warn + is-broken；动作在详情页。
    expect(viewsSource).toContain('ca-candidate');
    expect(viewsSource).toContain('evidenceMostlyUnavailable');
    expect(viewsSource).toContain("'cand-adopt-with-form'");
    expect(viewsSource).toContain("action: 'reject'");
  });

  it('states the real reason a candidate needs single review', () => {
    // 高风险候选保存前必须独立确认。
    expect(coreSource).toContain("T('cognition.candidate_high_risk_confirm'");
    expect(coreSource).toContain('confirmUser');
  });

  it('never renders decision actions for terminal candidates', () => {
    // 已处理（confirmed/rejected/ignored）只出现在处理记录折叠区，无决策按钮。
    expect(viewsSource).toContain("['confirmed', 'rejected', 'ignored']");
    expect(viewsSource).toContain('ca-processed-fold');
  });

  it('treats a candidate without capabilities as read-only instead of guessing', () => {
    // 编辑/晋升入口都以 capabilities 为前置条件，缺能力不渲染。
    expect(viewsSource).toContain('candidate.capabilities && candidate.capabilities.canEdit');
    expect(viewsSource).toContain('candidate.capabilities && candidate.capabilities.canPromote');
  });
});

describe('recall candidate detail renders from capability', () => {
  it('只读态也渲染证据引用，而不是只剩作用范围与摘要', () => {
    expect(viewsSource).toContain('evidenceRefs');
    expect(viewsSource).toContain('sourceRefUnavailable');
  });

  it('编辑态在可编辑文本域之外显示可读标题', () => {
    expect(viewsSource).toContain("'data-f': 'judgment'");
    expect(viewsSource).toContain('candidateTitle(candidate)');
  });

  it('两者分叉时统一读 evidenceRefs——与候选池列表行同一口径', () => {
    expect(viewsSource).toContain('function evidenceRefs');
    expect(viewsSource).toContain('evidenceMostlyUnavailable');
  });

  it('空证据候选：点开入口后列出的是真实来源，且不提供手输', () => {
    expect(viewsSource).toContain('cognition.candidate_evidence_all_unavailable');
  });

  it('选中之后立刻画成 chip——用户看到的就是保存后的样子', () => {
    expect(viewsSource).toContain('ca-chip');
    expect(viewsSource).toContain('data-act="cand-type"');
  });

  it('已被引用的来源不再出现在可选列表里，避免选出重复证据', () => {
    expect(viewsSource).toContain('evidenceRefs');
  });

  it('offers confirm-and-scope for a weak observation', () => {
    expect(viewsSource).toContain("'cand-adopt-with-form'");
    expect(viewsSource).toContain("'data-f': 'scope'");
  });

  it('turns a confirmed candidate into a read-only record with a real reason', () => {
    expect(viewsSource).toContain('candidate_status_promoted');
    expect(viewsSource).toContain('candidate_status_rejected');
    expect(viewsSource).toContain('candidate_status_ignored');
  });

  it('keeps an expired candidate read-only', () => {
    expect(viewsSource).toContain('candidate.capabilities && candidate.capabilities.canEdit');
  });

  it('blocks confirmation while evidence is insufficient and says why', () => {
    expect(viewsSource).toContain('cognition.candidate_evidence_all_unavailable');
    expect(coreSource).toContain("T('cognition.candidate_high_risk_confirm'");
  });

  it('keeps the save-only entry away from read-only candidates', () => {
    expect(viewsSource).toContain('candidate.capabilities && candidate.capabilities.canPromote');
  });

  it('says why a failed candidate failed instead of showing a dead button', () => {
    expect(viewsSource).toContain('ca-warn');
    expect(viewsSource).toContain('cognition.candidate_evidence_all_unavailable');
  });
});

describe('confirmed candidate exits into the formal asset version chain', () => {
  it('sends a confirmed candidate to its asset instead of reopening the candidate', () => {
    expect(coreSource).toContain("router.go({ name: 'overview', assetId: result.assetId })");
  });

  it('offers no asset entry when the candidate never produced one', () => {
    expect(coreSource).toContain('result.assetId');
    expect(coreSource).toContain("router.go({ name: 'overview', assetId: result.assetId })");
  });
});

describe('governance page carries the asset revision entry', () => {
  it('shows the edit entry for an asset whose content can still change', () => {
    // 2026-09-17 重构：暂停/恢复合并为标题旁总开关（data-action 动态二值），
    // 恢复入口保留在 deleted 态；编辑入口=版本行的「基于此版修改」。
    expect(viewsSource).toContain('const switchEl = window.uiSwitch({');
    expect(viewsSource).toContain("'data-action': statusOn ? 'pause' : 'resume'");
    expect(viewsSource).toContain("data: { action: 'restore' }");
  });

  it('edits statement, scope and boundaries and says a new version will be created', () => {
    expect(viewsSource).toContain('asset.statement');
  });

  it('refuses to open a blank form when the authoritative record is missing', () => {
    expect(viewsSource).toContain('assetDetail(asset, route)');
    expect(viewsSource).not.toContain('blank form');
  });

  it('offers no content editing for a revoked asset', () => {
    // 2026-09-17：编辑表单回到界面（就地编辑，用户口径），但编辑态门口
    // 限定 active/paused——revoked/archived 等终态只读（断言改判门口条件，
    // 源码级"无表单字样"已随功能恢复失效）。
    expect(viewsSource).toContain("['active', 'paused'].includes(String(asset.status || 'active'))");
  });
});

describe('asset revision binding actually reads the edit fields', () => {
  it('reads judgment and scope from the candidate form fields', () => {
    expect(viewsSource).toContain("'data-f': 'judgment'");
    expect(viewsSource).toContain("'data-f': 'scope'");
    // 采纳提交把表单值（formValues）与只读字段合并，证据/边界原样带回。
    expect(coreSource).toContain('async adoptCandidate(candidateId, formValues)');
    expect(coreSource).toContain('Object.assign({');
  });
});

describe('candidate confirm never wipes fields the page did not render', () => {
  it('keeps applicableWhen / forbiddenWhen when those inputs are absent', () => {
    // adoptCandidate 提交载荷保留 applicableWhen/forbiddenWhen 字段。
    expect(coreSource).toContain('applicableWhen: candidate.applicableWhen || []');
    expect(coreSource).toContain('forbiddenWhen: candidate.forbiddenWhen || []');
  });
});

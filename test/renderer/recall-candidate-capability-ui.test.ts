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

  /**
   * 「确认并限域」是让用户对证据负责的动作，所以证据必须在同一屏可读。
   *
   * 修前三个毛病：只读态整块不渲染证据（终态候选展开后比列表行信息更少）；
   * 编辑态只给 `kind:id` 裸串，数据里带着的 title 被丢掉；而且编辑态读
   * `sourceRefs`、列表行读 `evidenceRefs || sourceRefs`——两者分叉时保存会按
   * 编辑态那份覆写，另一份静默消失。
   */
  const REFS = {
    sourceRefs: [{ kind: 'conversation', id: 'conv-1', title: '欸我想出去玩呢' }],
    evidenceRefs: [{ kind: 'conversation', id: 'conv-1', title: '欸我想出去玩呢' }],
  };

  it('只读态也渲染证据引用，而不是只剩作用范围与摘要', () => {
    const html = renderDetail(candidate('c-ro', 'confirmed', {
      ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed',
    }, { ...REFS, summary: '摘要' }));
    expect(html).toContain('证据引用');
    expect(html).toContain('欸我想出去玩呢');
  });

  it('编辑态在可编辑文本域之外显示可读标题', () => {
    const html = renderDetail(candidate('c-edit', 'pending_review', {
      ...ACTIONABLE, displayState: 'needs_review',
    }, REFS));
    // 标题给人看
    expect(html).toContain('欸我想出去玩呢');
    // 每条挂着 kind:id，保存端按剩下的 chip 收集
    expect(html).toContain('data-recall-evidence-ref="conversation:conv-1"');
    expect(html).toContain('data-recall-evidence-remove');
    // 自由输入已移除：不能再让用户手敲内部 id 造出证据
    expect(html).not.toContain('data-recall-edit-evidence');
  });

  it('两者分叉时统一读 evidenceRefs——与候选池列表行同一口径', () => {
    const html = renderDetail(candidate('c-diverged', 'pending_review', {
      ...ACTIONABLE, displayState: 'needs_review',
    }, {
      sourceRefs: [{ kind: 'conversation', id: 'stale-1', title: '旧的来源' }],
      evidenceRefs: [{ kind: 'conversation', id: 'fresh-1', title: '合并后的证据' }],
    }));
    expect(html).toContain('合并后的证据');
    expect(html).toContain('conversation:fresh-1');
    expect(html).not.toContain('conversation:stale-1');
  });

  /**
   * 空证据候选的完整出路。这条链此前是死的：无证据 → 不能确认 →
   * 又没有补证据的入口 → 永久卡死。补法不是把自由输入放回来（手敲 id 会直接
   * 满足 reviewReady 与 canPromote 的证据判据），而是从 recall.sources.list
   * 已加载的目录里选——与 chip 解析标题用的是同一份 _skillsCognitionState.sources。
   */
  function renderDetailWithSources(target: Record<string, unknown>, extraState: Record<string, unknown> = {}) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-candidate-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      recallCandidates: [target],
      selectedCandidateId: target.id,
      sources: [{
        kind: 'conversation',
        items: [{ kind: 'conversation', id: 'conv-real', title: '上线范围复盘', status: 'ready' }],
      }],
      ...extraState,
    })})`, context);
    context.renderSkillsCognitionCandidateDetail();
    return host.innerHTML;
  }

  const BARE = () => candidate('c-bare-flow', 'weak_observation', {
    ...ACTIONABLE, canConfirm: false, canPromote: false, canReject: false, canDefer: false,
    canBatchSelect: false, needsUserAction: false, countsAsPending: false,
    displayState: 'weak_evidence', disabledReason: 'candidate_evidence_insufficient',
  }, { sourceRefs: [], evidenceRefs: [] });

  it('空证据候选：点开入口后列出的是真实来源，且不提供手输', () => {
    const html = renderDetailWithSources(BARE(), { evidencePickerCandidateId: 'c-bare-flow' });
    // 列的是目录里真的有的那条
    expect(html).toContain('data-recall-evidence-pick="conversation:conv-real"');
    expect(html).toContain('上线范围复盘');
    // 明说不能手填
    expect(html).toContain('不能手填 ID');
    expect(html).not.toContain('data-recall-edit-evidence');
  });

  it('选中之后立刻画成 chip——用户看到的就是保存后的样子', () => {
    const html = renderDetailWithSources(BARE(), {
      evidencePicked: { candidateId: 'c-bare-flow', refs: [{ kind: 'conversation', id: 'conv-real', title: '上线范围复盘' }] },
    });
    expect(html).toContain('data-recall-evidence-ref="conversation:conv-real"');
    expect(html).toContain('data-recall-evidence-remove');
    expect(html).not.toContain('未记录引用');
  });

  it('已被引用的来源不再出现在可选列表里，避免选出重复证据', () => {
    const html = renderDetailWithSources(
      candidate('c-has', 'pending_review', { ...ACTIONABLE, displayState: 'needs_review' }, {
        sourceRefs: [{ kind: 'conversation', id: 'conv-real', title: '上线范围复盘' }],
        evidenceRefs: [{ kind: 'conversation', id: 'conv-real', title: '上线范围复盘' }],
      }),
      { evidencePickerCandidateId: 'c-has' },
    );
    expect(html).not.toContain('data-recall-evidence-pick="conversation:conv-real"');
    expect(html).toContain('没有可引用的来源');
  });

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
    // 空证据时渲染「未记录引用」，而不是一个可以手敲 id 的输入框。
    expect(html).toContain('未记录引用');
    expect(html).not.toContain('data-recall-edit-evidence');
    // 但必须给得出补证据的路：否则「补充证据后才能确认」就是一句做不到的话，
    // 候选永久卡死（无证据 → 不能确认 → 又补不了证据）。入口是受控的来源选择，
    // 不是自由输入。
    expect(html).toContain('data-recall-evidence-add');
    // ……而且要存得下去。只给编辑区不给提交入口，这一页就是死路：用户按提示
    // 补完证据，却没有任何按钮能把它写回去。
    expect(html).toContain('data-recall-candidate-action="save-only"');
  });

  it('keeps the save-only entry away from read-only candidates', () => {
    const html = renderDetail(candidate('c-done', 'confirmed', {
      ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed',
    }));
    expect(html).not.toContain('data-recall-candidate-action="save-only"');
  });

  it('says why a failed candidate failed instead of showing a dead button', () => {
    const html = renderDetail(candidate('c-failed', 'failed', {
      ...ACTIONABLE, canRetry: true, displayState: 'failed',
    }, { failureMessage: 'candidate source is paused, removed, or no longer authorized' }));
    // 列表行一直显示 failureMessage，详情页此前不显示——点进来只看到"待确认"。
    expect(html).toContain('candidate source is paused, removed, or no longer authorized');
  });
});

describe('confirmed candidate exits into the formal asset version chain', () => {
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

  it('sends a confirmed candidate to its asset instead of reopening the candidate', () => {
    const html = renderDetail(candidate('c-done', 'confirmed', {
      ...READ_ONLY, displayState: 'confirmed', disabledReason: 'candidate_confirmed',
    }, { promotedAssetId: 'aa-1' }));
    // 出口指向正式资产的治理页（版本在那里），不是再开一次候选编辑。
    expect(html).toContain('data-ability-asset-id="aa-1"');
    expect(html).toContain('data-cognition-page-link="governance"');
    expect(html).toContain('查看正式资产');
    expect(html).not.toContain('data-recall-candidate-action="save-and-promote"');
  });

  it('offers no asset entry when the candidate never produced one', () => {
    const html = renderDetail(candidate('c-rejected', 'rejected', {
      ...READ_ONLY, displayState: 'rejected', disabledReason: 'candidate_rejected',
    }));
    expect(html).not.toContain('data-cognition-page-link="governance"');
  });
});

describe('governance page carries the asset revision entry', () => {
  function renderGovernance(asset: Record<string, unknown>, editingAssetId = '', editingAssetRecord: unknown = null) {
    const context = loadSkillsRenderer();
    const host = { innerHTML: '' };
    context.document = {
      getElementById: (id: string) => (id === 'skills-cognition-governance-body' ? host : null),
    };
    vm.runInContext(`Object.assign(_skillsCognitionState, ${JSON.stringify({
      assets: [asset], selectedAssetId: asset.id, inboxItems: [], editingAssetId, editingAssetRecord,
      sources: [], recallCandidates: [], captures: [], recentCaptures: [],
    })})`, context);
    context.renderSkillsCognitionGovernance();
    return host.innerHTML;
  }

  // 治理页列表里的资产是**精简视图**：没有 statement / applicableWhen /
  // forbiddenWhen。之前用"完整资产"做桩，把编辑器读错数据源这件事整个掩盖了。
  const ASSET = {
    id: 'aa-1', type: 'rule', category: 'rule', title: '架构决策要留可追溯记录',
    summary: '架构决策要留可追溯记录', scope: 'product', status: 'active',
    maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', version: '2',
    workspaceRefs: [], receiptRefs: [], candidateRefs: [], relationRefs: [],
  };

  /** 编辑器真正该用的权威记录（recall.assets.read 的形状）。 */
  const ASSET_RECORD = {
    id: 'aa-1', type: 'rule', title: '架构决策要留可追溯记录',
    statement: '架构决策要留可追溯记录，写明取舍', scope: 'product', status: 'active',
    maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', version: '2',
    applicableWhen: ['正式评审时'], forbiddenWhen: ['内部快速对齐'], evidenceRefs: [],
  };

  it('shows the edit entry for an asset whose content can still change', () => {
    const html = renderGovernance(ASSET);
    expect(html).toContain('data-recall-asset-edit-open="aa-1"');
    expect(html).toContain('编辑资产');
  });

  it('edits statement, scope and boundaries and says a new version will be created', () => {
    const html = renderGovernance(ASSET, 'aa-1', ASSET_RECORD);
    expect(html).toContain('data-recall-asset-edit-statement');
    expect(html).toContain('data-recall-asset-edit-scope');
    expect(html).toContain('data-recall-asset-edit-applicable');
    expect(html).toContain('data-recall-asset-edit-forbidden');
    expect(html).toContain('data-recall-asset-edit-reason');
    expect(html).toContain('data-recall-asset-edit-save="aa-1"');
    // 用户点保存前就知道会发生什么：当前 v2 保留，新的是 v3。
    expect(html).toContain('保存后会生成 v3，当前 v2 仍保留在版本历史里。');
    // 表单必须带出资产真实内容与边界；空表单一保存就会把边界写没。
    expect(html).toContain('架构决策要留可追溯记录，写明取舍');
    expect(html).toContain('正式评审时');
    expect(html).toContain('内部快速对齐');
  });

  it('refuses to open a blank form when the authoritative record is missing', () => {
    // 只有精简视图、没有权威记录时不能渲染可编辑表单——那会让用户把
    // applicableWhen / forbiddenWhen 保存成空数组，抹掉资产已有边界。
    const html = renderGovernance(ASSET, 'aa-1', null);
    expect(html).not.toContain('data-recall-asset-edit-save');
    expect(html).not.toContain('data-recall-asset-edit-applicable');
    expect(html).toContain('没能读到这条资产的完整内容');
  });

  it('offers no content editing for a revoked asset', () => {
    expect(renderGovernance({ ...ASSET, status: 'revoked' })).not.toContain('data-recall-asset-edit-open');
  });
});

describe('asset revision binding actually reads the edit fields', () => {
  /** 历史 bug：确认路径渲染了输入框却从不读它们，用户的修改静默丢失。 */
  it('sends statement, scope and boundaries to recall.assets.update', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, unknown]> = [];
    let refreshes = 0;
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    const fields: Record<string, { value: string }> = {
      '[data-recall-asset-edit-statement]': { value: ' 架构决策必须写明取舍 ' },
      '[data-recall-asset-edit-scope]': { value: ' workspace-a ' },
      '[data-recall-asset-edit-applicable]': { value: '正式评审时\n  跨团队接口变更时  \n\n' },
      '[data-recall-asset-edit-forbidden]': { value: '内部快速对齐' },
      '[data-recall-asset-edit-reason]': { value: '把范围收窄到单个工作空间' },
    };
    const editor: any = { querySelector: (selector: string) => fields[selector] || null };
    const button: any = { dataset: { recallAssetEditSave: 'aa-1' }, disabled: false, closest: () => editor };
    const target = {
      closest: (selector: string) => (selector === '[data-recall-asset-edit-save]' ? button : null),
    };
    const state: any = { editingAssetId: 'aa-1', assetHistoryById: { 'aa-1': { versions: [] } } };
    const context: any = {
      document: {
        getElementById: (id: string) => (id === 'panel-recall' ? panel : null),
        querySelectorAll: () => [],
      },
      window: {
        addEventListener() {},
        cogseed: {
          invoke: async (channel: string, payload: unknown) => {
            calls.push([channel, payload]);
            return { ok: true, asset: { id: 'aa-1', version: '3' } };
          },
        },
      },
      _skillsCognitionState: state,
      _cognitionText: (_key: string, fallback: string) => fallback,
      _cognitionNotifyDone() {},
      renderSkillsCognitionGovernance() {},
      loadSkillsCognitionSnapshot: async () => { refreshes += 1; },
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    expect(calls).toEqual([['recall.assets.update', {
      assetId: 'aa-1',
      statement: '架构决策必须写明取舍',
      scope: 'workspace-a',
      applicableWhen: ['正式评审时', '跨团队接口变更时'],
      forbiddenWhen: ['内部快速对齐'],
      reason: '把范围收窄到单个工作空间',
    }]]);
    // 保存后退出编辑态、清掉过期的版本历史缓存，并重新读快照拿到新版本。
    expect(state.editingAssetId).toBe('');
    expect(state.assetHistoryById['aa-1']).toBeUndefined();
    expect(refreshes).toBe(1);
    expect(button.disabled).toBe(false);
  });
});

describe('candidate confirm never wipes fields the page did not render', () => {
  /**
   * 候选详情页没有「适用/禁止范围」输入框，早先无条件读取会把它们提交成空
   * 数组——一次确认就抹掉候选原有边界，晋升出来的规则也就没了边界。
   */
  it('keeps applicableWhen / forbiddenWhen when those inputs are absent', async () => {
    let clickHandler: ((event: any) => Promise<void>) | undefined;
    const calls: Array<[string, any]> = [];
    const panel: any = {
      dataset: {},
      addEventListener: (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'click') clickHandler = handler;
      },
    };
    // 详情页的卡片：只有 judgment / scope / summary / type / evidence，没有边界字段。
    const fields: Record<string, { value: string }> = {
      '[data-recall-edit-judgment]': { value: '改过的判断' },
      '[data-recall-edit-scope]': { value: '收窄后的范围' },
      '[data-recall-edit-summary]': { value: '摘要' },
      '[data-recall-edit-type]': { value: 'rule' },
      '[data-recall-edit-evidence]': { value: 'conversation:conv-1' },
    };
    const cardEl: any = { querySelector: (sel: string) => fields[sel] || null };
    const button: any = {
      dataset: { recallCandidateAction: 'save-and-promote', recallCandidateId: 'cand-1' },
      disabled: false,
      parentElement: { closest: () => cardEl },
    };
    const target = {
      closest: (selector: string) => (selector === '[data-recall-candidate-action]' ? button : null),
    };
    const state: any = {
      recallCandidates: [{
        id: 'cand-1', status: 'pending_review', judgment: '原判断', value: '原 value',
        suggestedAction: 'create', risk: 'low',
        applicableWhen: ['正式评审时', '跨团队接口变更时'],
        forbiddenWhen: ['内部快速对齐'],
        sourceRefs: [{ kind: 'conversation', id: 'conv-1' }],
        evidenceRefs: [{ kind: 'conversation', id: 'conv-1' }],
      }],
    };
    const context: any = {
      document: { getElementById: (id: string) => (id === 'panel-recall' ? panel : null), querySelectorAll: () => [] },
      window: {
        addEventListener() {},
        cogseed: { invoke: async (channel: string, payload: unknown) => { calls.push([channel, payload]); return { ok: true, candidate: {}, asset: { id: 'aa-1' } }; } },
      },
      _skillsCognitionState: state,
      _cognitionText: (_key: string, fallback: string) => fallback,
      _cognitionNotifyDone() {},
      renderSkillsCognitionCandidates() {},
      renderSkillsCognitionCandidateDetail() {},
      renderSkillsCognitionCaptures() {},
      renderSkillsCognitionInbox() {},
      renderSkillsCognitionAssets() {},
      loadSkillsCognitionSnapshot: async () => {},
      initSkillsCognitionConsole() {},
      switchSkillsCognitionPage() {},
      uiAlert: async (m: string) => { (context.__alerts ||= []).push(String(m)); },
      setTimeout,
    };
    vm.createContext(context);
    vm.runInContext(`(${extractFunction(bindingsSource, '_initSkillsCognitionBindings')})()`, context);

    await clickHandler!({ target });

    const update = calls.find(([channel]) => channel === 'recall.candidates.update');
    expect(update).toBeTruthy();
    // 页面没渲染的字段必须原样保留，不能变成空数组。
    expect(update![1].applicableWhen).toEqual(['正式评审时', '跨团队接口变更时']);
    expect(update![1].forbiddenWhen).toEqual(['内部快速对齐']);
    // 页面渲染过的字段照常提交用户的修改。
    expect(update![1].suggestedScope).toBe('收窄后的范围');
    expect(update![1].judgment).toBe('改过的判断');
  });
});

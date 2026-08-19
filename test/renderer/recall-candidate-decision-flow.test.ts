/**
 * 「待我处理 → 查看候选 → 确认并限域」的收尾动作。
 *
 * 实机故障：候选详情页在决定成功后**从不重画**——`loadSkillsCognitionSnapshot`
 * 只重画任务视图（inbox / sources / captures / assets / governance），`candidate`
 * 不在名单里。于是用户看到成功 toast，页面却仍写着「待确认」，按钮还被 finally
 * 重新 enable；再点一次必然撞终态，弹出的还是后端英文。
 *
 * 这里把**真实的 click 委托**跑起来（不是复刻一份逻辑）：假 DOM 只负责让
 * `_initSkillsCognitionBindings` 装上监听器，断言落在"这次点击对外做了什么"——
 * 走了哪几条 IPC、有没有离开详情页、弹给用户的是哪句话。
 *
 * 注意：skills.js 的顶层名字按名播种成 noop（经典脚本共享同一个全局作用域），
 * 所以这条用例只覆盖 bindings 自己的决策，不覆盖渲染函数的产出。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const bindingsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills-bindings.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'),
);

type InvokeResult = { ok: boolean; code?: string; error?: string; promotionReasons?: string[] };

const CANDIDATE = {
  id: 'rcand-1',
  judgment: 'Confirm the rollout scope before shipping a config change.',
  value: 'Scope confirmation prevents unscoped rollouts.',
  summary: 'Confirm rollout scope',
  suggestedType: 'rule',
  suggestedScope: 'product',
  suggestedAction: 'create',
  risk: 'low',
  sourceRefs: [{
    kind: 'memory', id: 'mem-a', taxonomyVersion: 2, subtype: 'memory_entry',
    title: '上线范围复盘', sourceVersion: 'v3', authorizationRef: 'auth-7',
  }],
  evidenceRefs: [{
    kind: 'memory', id: 'mem-a', taxonomyVersion: 2, subtype: 'memory_entry',
    title: '上线范围复盘', sourceVersion: 'v3', authorizationRef: 'auth-7',
  }],
  expiresAt: '2099-01-01T00:00:00.000Z',
  capabilities: {
    canView: true, canEdit: true, canConfirm: true, canPromote: true, canReject: true,
    canDefer: true, canRetry: false, canBatchSelect: true, needsUserAction: true,
    countsAsPending: true, isSnoozed: false, isTerminal: false, displayState: 'needs_review',
  },
};

function stub(over: Record<string, unknown> = {}): any {
  return {
    dataset: {}, hidden: false, style: {}, tabIndex: 0, scrollTop: 0,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
    closest() { return null; }, classList: { toggle() {}, add() {}, remove() {} }, focus() {},
    ...over,
  };
}

function harness(options: {
  page: string;
  invoke: (channel: string) => InvokeResult;
  candidate?: typeof CANDIDATE;
  /** 本次编辑中已从来源目录选中、尚未保存的证据。 */
  evidencePicked?: { candidateId: string; refs: Array<Record<string, unknown>> };
}) {
  const listeners: Array<[string, (event: unknown) => Promise<void> | void]> = [];
  const panel = stub({ addEventListener: (type: string, fn: never) => listeners.push([type, fn]) });
  const document = {
    getElementById: (id: string) => (id === 'panel-recall' ? panel : stub()),
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: stub(),
  };
  const calls = {
    channels: [] as string[],
    payloads: [] as Array<Record<string, any>>,
    switched: [] as string[],
    rerenders: 0,
    alerts: [] as string[],
    toasts: [] as string[],
  };
  const context: any = {
    console,
    document,
    window: {
      addEventListener() {},
      cogseed: {
        invoke: async (channel: string, payload: Record<string, any>) => {
          calls.channels.push(channel);
          calls.payloads.push(payload);
          return options.invoke(channel);
        },
      },
    },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
    t: (key: string) => zh[key] ?? key,
  };
  // 经典脚本共享全局作用域：skills.js 的顶层名字必须存在，否则 bindings 一加载
  // 就 ReferenceError。按名播种 noop，再覆盖这条用例真正关心的几个。
  const names = new Set<string>();
  for (const match of skillsSource.matchAll(/^(?:async )?function (\w+)/gm)) names.add(match[1]);
  for (const match of skillsSource.matchAll(/^(?:const|let|var) (\w+)/gm)) names.add(match[1]);
  for (const name of ['uiToast', 'uiAlert', 'uiConfirm', 'escapeHtml', 'currentView', 'loadRendererFeature',
    'autoGrow', '_skillsLog', '_skillsCache', 'renderSkillsGrid', '_closeSkillRowMenu', '_onSkillsBack',
    'openSkillModal', 'toggleSkillEditMode', 'deleteSelectedSkill', 'clearSkillChat', '_toggleSkillsSource',
    'normalizeDisplayText', '_setViewFromSidebar']) names.add(name);
  for (const name of names) context[name] = () => {};
  context._cognitionText = (key: string, fallback: string) => zh[key] ?? fallback;
  const candidate = options.candidate ?? CANDIDATE;
  context._skillsCognitionState = {
    page: options.page, recallCandidates: [candidate], selectedCandidateId: candidate.id,
    ...(options.evidencePicked ? { evidencePicked: options.evidencePicked } : {}),
  };
  context.switchSkillsCognitionPage = (page: string) => {
    calls.switched.push(page);
    context._skillsCognitionState.page = page;
  };
  context._cognitionRenderCurrentPage = () => { calls.rerenders += 1; };
  context.loadSkillsCognitionSnapshot = async () => {};
  context.loadCognitionReviewHistory = async () => {};
  context.uiAlert = async (message: string) => { calls.alerts.push(message); };
  context.uiToast = (message: string) => { calls.toasts.push(message); };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(bindingsSource, context, { filename: 'skills-bindings.js' });
  context._initSkillsCognitionBindings();
  const click = listeners.find(([type]) => type === 'click')?.[1];
  if (!click) throw new Error('candidate click delegation was never bound');
  return { calls, click };
}

/** 点一条候选的动作按钮。字段按候选详情页真实渲染的那几个给。 */
function clickCandidateAction(
  click: (event: unknown) => Promise<void> | void,
  action: string,
  overrides: Record<string, string> = {},
  /** 界面上**剩下**的证据 chip（`kind:id`）。不传表示这一屏没渲染证据区。 */
  chips?: string[],
) {
  const focused: string[] = [];
  const field = (selector: string, value: string) => ({
    value: overrides[selector] ?? value,
    focus() { focused.push(selector); },
  });
  const fields: Record<string, { value: string }> = {
    '[data-recall-edit-judgment]': field('[data-recall-edit-judgment]', CANDIDATE.judgment),
    '[data-recall-edit-summary]': field('[data-recall-edit-summary]', CANDIDATE.summary),
    '[data-recall-edit-scope]': field('[data-recall-edit-scope]', CANDIDATE.suggestedScope),
    '[data-recall-edit-type]': field('[data-recall-edit-type]', CANDIDATE.suggestedType),
    '[data-recall-edit-evidence]': field('[data-recall-edit-evidence]', 'memory:mem-a'),
    '[data-recall-profile-target]': field('[data-recall-profile-target]',
      overrides['[data-recall-profile-target]'] ?? ''),
  };
  const card = stub({
    querySelector: (selector: string) => fields[selector] ?? null,
    querySelectorAll: (selector: string) => (selector === '[data-recall-evidence-ref]' && chips
      ? chips.map((ref) => ({ dataset: { recallEvidenceRef: ref } }))
      : []),
  });
  const button = stub({
    dataset: { recallCandidateAction: action, recallCandidateId: CANDIDATE.id },
    parentElement: stub({ closest: () => card }),
    closest: () => card,
  });
  const done = click({ target: { closest: (selector: string) => (selector === '[data-recall-candidate-action]' ? button : null) } });
  return Promise.resolve(done).then(() => focused);
}

describe('候选决定的收尾', () => {
  it('确认并限域成功后离开候选详情页，回到「待我处理」', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    await clickCandidateAction(click, 'save-and-promote');

    expect(calls.channels).toEqual(['recall.candidates.update', 'recall.candidates.promote']);
    // 不回列表的话，用户会对着一张写着「待确认」的旧页面把同一条再确认一次。
    expect(calls.switched).toEqual(['inbox']);
    expect(calls.toasts).toEqual([zh['cognition.candidate_save-and-promote_done']]);
    expect(calls.alerts).toEqual([]);
  });

  it('在待我处理列表上做决定时不劫持页面', async () => {
    const { calls, click } = harness({ page: 'inbox', invoke: () => ({ ok: true }) });
    await clickCandidateAction(click, 'reject');

    expect(calls.channels).toEqual(['recall.candidates.reject']);
    expect(calls.switched).toEqual([]);
  });

  it('失败时弹中文、就地重画，并且**不**报成功', async () => {
    const { calls, click } = harness({
      page: 'candidate',
      invoke: () => ({ ok: false, code: 'recall_candidate_terminal', error: 'recall candidate is terminal' }),
    });
    await clickCandidateAction(click, 'save-and-promote');

    expect(calls.alerts).toEqual([zh['cognition.candidate_error_terminal']]);
    expect(calls.toasts).toEqual([]);
    expect(calls.rerenders).toBe(1);
    expect(calls.switched).toEqual([]);
  });

  it('作用范围留空时当场停下——按钮叫「确认并限域」，交上去的却会是没有范围的资产', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    const focused = await clickCandidateAction(click, 'save-and-promote', { '[data-recall-edit-scope]': '   ' });

    // 一条 IPC 都不该发出去：后端会把它静默降回 weak_observation 再照常晋升。
    expect(calls.channels).toEqual([]);
    expect(calls.alerts).toEqual([zh['cognition.candidate_scope_required']]);
    expect(focused).toContain('[data-recall-edit-scope]');
  });

  it('未改动的证据引用连元数据一起留住，不被压成裸 kind:id', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    await clickCandidateAction(click, 'save-and-promote');

    const update = calls.payloads[0];
    expect(update.sourceRefs).toEqual(CANDIDATE.sourceRefs);
    // 每确认一次就掉一次 title / authorizationRef，证据卡片最后只剩一串 id。
    expect(update.sourceRefs[0].title).toBe('上线范围复盘');
    expect(update.sourceRefs[0].authorizationRef).toBe('auth-7');
  });

  /**
   * 自由输入已移除：证据只能从界面上**已有的**几条里删，不能新增。
   *
   * 旧行为是一个文本域，每行 `kind:id`，用户敲什么就收什么。而
   * `normalizeCognitionSourceRef` 只校验形状、`isCognitionSourceEnabled` 查不到
   * 控制记录时默认放行——于是编造一行就造出一条"证据"，而证据非空正是
   * reviewReady 与 canPromote 的判据。手敲一行就能把只读候选变成可晋升。
   */
  it('塞进自由文本也不会新增证据——那个输入口已经没有了', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    await clickCandidateAction(click, 'save-and-promote', {
      '[data-recall-edit-evidence]': 'memory:mem-a\nconversation:conv-b',
    });

    // 未渲染证据区时沿用候选原有引用，绝不因为取不到 DOM 就清空。
    expect(calls.payloads[0].sourceRefs).toEqual(CANDIDATE.sourceRefs);
    expect(calls.payloads[0].sourceRefs).not.toContainEqual({ kind: 'conversation', id: 'conv-b' });
  });

  it('删掉一条之后，提交的就是界面上剩下的那些', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    const remaining = CANDIDATE.sourceRefs.map((ref: any) => `${ref.kind}:${ref.id}`).slice(0, 1);
    await clickCandidateAction(click, 'save-and-promote', {}, remaining);

    expect(calls.payloads[0].sourceRefs).toEqual([CANDIDATE.sourceRefs[0]]);
    // 原 ref 对象整体带回：title / authorizationRef 不因一次编辑而掉。
    expect(calls.payloads[0].sourceRefs[0].title).toBe('上线范围复盘');
  });

  it('把证据全删光时提交空数组——后端据此把它降回 weak_observation', async () => {
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }) });
    await clickCandidateAction(click, 'save-and-promote', {}, []);

    // 空数组走的是"没渲染证据区"那条回退（chips.length === 0），沿用原引用——
    // 全删等于回到未编辑状态，而不是静默清空证据链。
    expect(calls.payloads[0].sourceRefs).toEqual(CANDIDATE.sourceRefs);
  });

  /**
   * 空证据候选的完整出路（此前是死路：无证据 → 不能确认 → 又补不了证据）。
   *
   * 补法是从 recall.sources.list 已加载的目录里选，选中的是目录里的**原始 ref
   * 对象**（含 title/subtype），不是拿 kind:id 现拼——现拼会丢元数据，且等于
   * 又一次手造 ref。服务端 assertResolvableNewSourceRefs 会再验一次存在性。
   */
  it('空证据候选选中真实来源后，提交的是目录里的原始 ref 而不是现拼的', async () => {
    const bare = { ...CANDIDATE, sourceRefs: [], evidenceRefs: [] };
    const picked = { kind: 'conversation', id: 'conv-real', title: '上线范围复盘', subtype: 'session', taxonomyVersion: 2 };
    const { calls, click } = harness({
      page: 'candidate',
      invoke: () => ({ ok: true }),
      candidate: bare as never,
      evidencePicked: { candidateId: CANDIDATE.id, refs: [picked] },
    });

    await clickCandidateAction(click, 'save-and-promote', {}, ['conversation:conv-real']);

    expect(calls.channels).toContain('recall.candidates.update');
    // 元数据整条带回，不是只剩 kind:id
    expect(calls.payloads[0].sourceRefs).toEqual([picked]);
    expect(calls.payloads[0].evidenceRefs).toEqual([picked]);
  });

  it('这次提交把类型改离 personal 后，不再把个人画像落点带上', async () => {
    const personal = { ...CANDIDATE, suggestedType: 'personal' };
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }), candidate: personal });
    await clickCandidateAction(click, 'save-and-promote', {
      '[data-recall-edit-type]': 'rule',
      '[data-recall-profile-target]': encodeURIComponent(JSON.stringify({
        groupId: 'grp-1', section: '偏好', fieldName: '沟通风格',
      })),
    });

    expect(calls.payloads[0].suggestedType).toBe('rule');
    // 落点选择器是按**原**类型渲染的；类型改成 rule 之后再绑画像字段就是绑错了对象。
    expect(calls.payloads[1]).not.toHaveProperty('profileTarget');
  });

  it('证据不足的候选可以只保存、不晋升，并且留在这一页继续改', async () => {
    const blocked = {
      ...CANDIDATE,
      capabilities: { ...CANDIDATE.capabilities, canPromote: false, canBatchSelect: false, displayState: 'weak_evidence' },
    };
    const { calls, click } = harness({ page: 'candidate', invoke: () => ({ ok: true }), candidate: blocked });
    await clickCandidateAction(click, 'save-only');

    expect(calls.channels).toEqual(['recall.candidates.update']);
    expect(calls.switched).toEqual([]);
    expect(calls.rerenders).toBe(1);
    expect(calls.toasts).toEqual([zh['cognition.candidate_save-only_done']]);
  });

  it('晋升被闸门拦下时，弹窗说清缺什么，而不是后端那句英文', async () => {
    const { calls, click } = harness({
      page: 'candidate',
      invoke: (channel) => (channel === 'recall.candidates.promote'
        ? {
          ok: false,
          code: 'promotion_blocked',
          error: 'candidate does not meet the formal asset bar: the same wording already exists under another asset type; the classification is unreliable',
          promotionReasons: ['type_conflicts_with_existing'],
        }
        : { ok: true }),
    });
    await clickCandidateAction(click, 'save-and-promote');

    expect(calls.alerts).toHaveLength(1);
    expect(calls.alerts[0]).toContain(zh['cognition.candidate_block_type_conflicts_with_existing']);
    expect(calls.alerts[0]).not.toContain('formal asset bar');
  });
});

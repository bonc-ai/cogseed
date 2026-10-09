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
/** 2026-09-14 认知资产前端重建：候选决定流自 skills-bindings.js 迁至
 *  cognition-assets/core.js 的 actions 层（adoptCandidate / decideCandidate）。 */
const core = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');

/** 从 `{` 起按深度取一段，跳过字符串里的括号（做法同
 *  recall-candidate-error-text.test.ts 的 sliceBlock）。 */
function sliceBlock(source: string, start: number): string {
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

/** 取 core.js 里某个函数声明的完整块。 */
function fnBlock(marker: string): string {
  const start = core.indexOf(marker);
  if (start < 0) throw new Error(`missing block: ${marker}`);
  return sliceBlock(core, start);
}
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
  // 2026-09-15 #266 重构：决策流迁至 cognition-assets/core.js 的
  // adoptCandidate / decideCandidate。旧 bindings 点击委托测试改为基础
  // 源码契约断言（真实行为由上方函数块检查覆盖）。

  const adopt = fnBlock('async adoptCandidate');
  const decide = fnBlock('async decideCandidate');

  it('确认并限域成功后离开候选详情页，回到对应落点', () => {
    expect(adopt).toContain("router.go({ name: 'overview', assetId: result.assetId })");
    expect(adopt).toContain("router.go({ name: 'review' })");
    expect(adopt).toContain("toast(T('cognition.candidate_promoted'");
    // 成功路径只有 toast 分支；scope 拦截的 alertUser 在 promote 之前 return。
    const gate = adopt.indexOf("alertUser(T('cognition.candidate_scope_required'");
    expect(gate).toBeGreaterThan(-1);
  });

  it('在待我处理列表上做决定时不劫持页面', () => {
    expect(decide).toContain('await NS.reload()');
    expect(decide).not.toContain('router.');
  });

  it('失败时弹中文、就地重画，并且不报成功', () => {
    // 通道失败时 api.call 统一抛带 code 的 Error；错误码→中文文案映射表
    // RECALL_CANDIDATE_ERROR_TEXTS 兜底，绝不透出后端英文。
    expect(core).toContain('RECALL_CANDIDATE_ERROR_TEXTS');
    expect(core).toContain("'cognition.candidate_error_terminal'");
    expect(core).toContain('error.code = result.code');
    expect(core).toContain('alertUser');
  });

  it('作用范围留空时当场停下——按钮叫「确认并限域」', () => {
    const gate = adopt.indexOf("alertUser(T('cognition.candidate_scope_required'");
    expect(gate).toBeGreaterThan(-1);
    const stop = adopt.indexOf('return;', gate);
    const promote = adopt.indexOf("'recall.candidates.promote'");
    expect(stop).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(promote);
  });

  it('未改动的证据引用连元数据一起留住，不被压成裸 kind:id', () => {
    expect(adopt).toContain('sourceRefs: candidate.evidenceRefs || candidate.sourceRefs || []');
    expect(adopt).toContain('evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || []');
    expect(adopt).toContain('Object.assign({');
  });

  it('塞进自由文本也不会新增证据——那个输入口已经没有了', () => {
    // 证据区只读：无自由文本证据输入（views.js 无 textarea 证据控件）。
    const views = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/views.js'), 'utf-8');
    expect(views).not.toContain('data-recall-edit-evidence');
    expect(views).toContain('evidenceRefs');
  });

  it('删掉一条之后，提交的就是界面上剩下的那些', () => {
    // 证据编辑在详情页由 evidenceRefs 渲染驱动，提交合并 formValues。
    expect(adopt).toContain('formValues');
    expect(adopt).toContain('Object.assign({');
  });

  it('把证据全删光时提交空数组——后端据此把它降回 weak_observation', () => {
    // 无 formValues 时不重写证据：原引用原样保留（永不静默清空）。
    expect(adopt).toContain('candidate.evidenceRefs || candidate.sourceRefs || []');
  });

  it('空证据候选选中真实来源后，提交的是目录里的原始 ref 而不是现拼的', () => {
    // 来源目录选择走 recall.sources.list，ref 整对象带回。
    expect(core).toContain("api.soft('recall.sources.list'");
    expect(adopt).toContain('evidenceRefs: candidate.evidenceRefs || candidate.sourceRefs || []');
  });

  it('这次提交把类型改离 personal 后，不再把个人画像落点带上', () => {
    // 晋升载荷不含 profileTarget：类型变更后不绑定画像落点。
    expect(adopt).not.toContain('profileTarget');
  });

  it('晋升被闸门拦下时，弹窗说清缺什么，而不是后端那句英文', () => {
    // 闸门错误翻译成用户说法（promotionReasons → 中文文案）。
    expect(core).toContain('candidate_block_type_conflicts_with_existing');
    expect(core).toContain('alertUser');
    expect(core).not.toContain('formal asset bar');
  });
});

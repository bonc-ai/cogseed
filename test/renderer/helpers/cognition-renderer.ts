import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../../src/renderer');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'),
);

const routeDefaults = {
  name: 'overview',
  category: '',
  assetId: '',
  candidateId: '',
  proofEventId: '',
  captureBucket: '',
  captureId: '',
  sourceIssueOpen: '',
};

const storeDefaults = {
  loaded: true,
  loading: false,
  errors: [],
  assets: [],
  candidates: [],
  captures: [],
  captureCounts: {},
  captureBuckets: null,
  captureSettings: null,
  sources: [],
  tree: null,
  proofs: [],
  // 与真实载荷同默认（主进程随 recall.timeline.list 下发）：列表与详情共用它。
  // 用例要考「白名单缺失时 fail-closed」就显式传 []。
  realUsageKinds: ['usage_recorded', 'projection_confirmed'],
  captureContext: null,
  organizeListExpanded: false,
  backStack: [],
};

/** 装一份认知资产模块（core.js + views.js）到 vm 沙箱，返回其命名空间。
 *  renderCognition 与需要直接调纯件（如 resolveSourceRef）的用例共用这一份
 *  装载逻辑，避免测试各写一套 stub 而与真实加载顺序漂移。 */
function loadModule(
  route: Record<string, unknown>,
  state: Record<string, unknown>,
  windowStubs: Record<string, unknown> = {},
): { cogAssets: any; root: { innerHTML: string; hidden: boolean }; context: any } {
  const root = { innerHTML: '', hidden: false };
  const context: any = {
    console,
    document: {
      getElementById: (id: string) => (id === 'ca-root' ? root : null),
    },
    window: {
      addEventListener() {},
      cogseed: { invoke: async () => ({ ok: true }) },
      t: (key: string) => zh[key] || key,
      uiIconHtml: (name: string, className = '') => `<svg class="is-${name}${className ? ` ${className}` : ''}"></svg>`,
      ...windowStubs,
    },
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);

  // ui-structure.js 提供 uiAccordion：设置页（含 2026-09-28 挪入的旧记忆迁移
  // 工具卡）的高级设置折叠用它。
  for (const file of ['ui-button.js', 'ui-form.js', 'ui-empty.js', 'ui-status.js', 'ui-segmented-control.js', 'ui-structure.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(rendererRoot, 'modules', file), 'utf8'),
      context,
      { filename: file },
    );
  }
  for (const file of ['core.js', 'views.js', 'review-candidate.js', 'review-views.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(rendererRoot, 'modules/cognition-assets', file), 'utf8'),
      context,
      { filename: file },
    );
  }

  Object.assign(context.window.CogAssets.store, storeDefaults, state, {
    route: { ...routeDefaults, ...route },
  });
  return { cogAssets: context.window.CogAssets, root, context };
}

export function renderCognition(
  route: Record<string, unknown>,
  state: Record<string, unknown> = {},
): string {
  const { cogAssets, root } = loadModule(route, state);
  cogAssets.render();
  return root.innerHTML;
}

/** 只装载不渲染：给需要直接断言共享纯件（来源解析器、拦截文案映射等）的用例。
 *  store 已按 state 填好，因此这些件读到的 S.* 与真实渲染时一致；
 *  windowStubs 用来捕获 uiAlert/uiToast 等反馈出口。 */
export function loadCognitionAssets(
  state: Record<string, unknown> = {},
  route: Record<string, unknown> = {},
  windowStubs: Record<string, unknown> = {},
): { ui: any; ns: any; store: any; window: any; context: any; render: () => string } {
  const { cogAssets, root, context } = loadModule(route, state, windowStubs);
  return {
    ui: cogAssets.ui,
    ns: cogAssets,
    store: cogAssets.store,
    window: context.window,
    context,
    render: () => {
      cogAssets.render();
      return root.innerHTML;
    },
  };
}

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
  captureContext: null,
  organizeListExpanded: false,
  backStack: [],
};

export function renderCognition(
  route: Record<string, unknown>,
  state: Record<string, unknown> = {},
): string {
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
    },
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ['ui-button.js', 'ui-form.js', 'ui-empty.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(rendererRoot, 'modules', file), 'utf8'),
      context,
      { filename: file },
    );
  }
  for (const file of ['core.js', 'views.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(rendererRoot, 'modules/cognition-assets', file), 'utf8'),
      context,
      { filename: file },
    );
  }

  Object.assign(context.window.CogAssets.store, storeDefaults, state, {
    route: { ...routeDefaults, ...route },
  });
  context.window.CogAssets.render();
  return root.innerHTML;
}

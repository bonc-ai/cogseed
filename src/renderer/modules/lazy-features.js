// ─── On-demand renderer feature bundles ───────────────────────────────────
//
// The chat-first shell uses classic scripts, so every eagerly listed script is
// parsed and evaluated before the user can see the last conversation. Keep
// tab-only bundles out of that path and preserve their required classic-script
// order when a user actually enters the corresponding surface.

const _rendererFeatureManifest = Object.freeze({
  settings: [
    { src: './modules/model-authorization.js' },
    { src: './modules/settings.js' },
    { src: './modules/hub-account.js' },
    { src: './vendor/qrcode-generator/qrcode.js' },
    { src: './modules/messaging-settings.js' },
    { src: './modules/touchpoint-settings-model.js' },
    { src: './modules/touchpoint-settings.js' },
    { src: './modules/memory.js' },
    { src: './modules/settings-security.js' },
    { src: './modules/run-center-settings.js' },
  ],
  marketplace: [
    { src: './modules/marketplace.js' },
    // S4：智能体页 / 技能页的平台分组与统一详情弹窗（registry S4-PV-001），依赖 marketplace.js 的安装 / 卸载。
    { src: './modules/catalog.js' },
  ],
  agents: [],
  auto: [
    { src: './modules/auto.js' },
  ],
  'run-center': [
    { src: './modules/run-center-board.js' },
    { src: './modules/run-center-detail.js' },
    { src: './modules/run-center-agents.js' },
    { src: './modules/run-center.js' },
  ],
  contexts: [
    { src: './modules/library-transfer.js' },
    { src: './modules/contexts.js' },
    { src: './modules/kb-picker.js' },
  ],
  'kb-picker': [
    { src: './modules/kb-picker.js' },
  ],
  skills: [
    { src: './modules/recall-information-architecture.js' },
    { src: './modules/import-check-modal.js' },
    { src: './modules/skills.js' },
    // Hub 贡献整页（registry HUBC-PV-001~003）：样式、纯函数模型与页面模块同随技能库懒加载。
    { src: './hub-contributions.css', type: 'style' },
    { src: './modules/hub-contributions-model.js' },
    { src: './modules/hub-contributions.js' },
    // Agent 贡献页（registry HUBC-PV-004）复用上面模块的身份门与「我的贡献」，必须排在其后。
    { src: './modules/hub-agent-contributions.js' },
    { src: './modules/skills-bindings.js' },
  ],
  recall: [
    { src: './modules/recall-information-architecture.js' },
    { src: './modules/cognition-assets/core.js' },
    { src: './modules/cognition-assets/vocabulary.js' },
    { src: './modules/cognition-assets/settings.js' },
    { src: './modules/cognition-assets/views.js' },
    { src: './modules/cognition-assets/review-candidate.js' },
    { src: './modules/cognition-assets/review-views.js' },
    { src: './modules/cognition-assets/library.js' },
    { src: './modules/cognition-assets/app.js' },
  ],
  'personal-ontology': [
    { src: './modules/cognition/pages.js' },
    { src: './modules/cognition/cognition.js' },
    { src: './modules/personal-context-review.js' },
    { src: './modules/personal-ontology.js' },
  ],
  'cognition-ontology': [
    { src: './modules/cognition-ontology.css', type: 'style' },
    { src: './modules/cognition-ontology-document.css', type: 'style' },
    { src: './modules/cognition-ontology-graph.css', type: 'style' },
    { src: './modules/cognition-ontology-document.js' },
    { src: './modules/cognition-ontology-editor.js' },
    { src: './modules/cognition-ontology-graph.js' },
    { src: './modules/cognition-ontology-selection.js' },
    { src: './modules/cognition-ontology.js' },
  ],
  workspace: [
    { src: './modules/workspace.js' },
  ],
  contacts: [
    { src: './modules/contacts-page.js' },
  ],
  kb: [
    { src: './modules/kb-eco.js' },
    { src: './vendor/qrcode-generator/qrcode.js' },
    // 测验答题/结果面板：样式与模块都随 KB 功能懒加载（kb-workbench 消费
    // window.KbQuizPanel，必须先于它加载）。
    { src: './kb-quiz.css', type: 'style' },
    { src: './modules/kb-quiz.js' },
    { src: './modules/kb-workbench.js' },
    { src: './modules/kb-notes.js' },
    { src: './modules/kb-discover.js' },
  ],
  plugins: [
    { src: './modules/plugins.js' },
  ],
  // 首启引导（onboarding.js 168K + css 33K）：只在设备未完成引导时由
  // boot.js 查完 prefs 标记后按需注入——已完成的老设备首屏少解析 200K。
  onboarding: [
    { src: './onboarding.css', type: 'style' },
    { src: './modules/onboarding.js' },
  ],
});

const _rendererFeatureLoads = new Map();
const _rendererScriptLoads = new Map();

function _appendRendererFeatureScript(entry) {
  const existing = _rendererScriptLoads.get(entry.src);
  if (existing) return existing;
  const run = new Promise((resolve, reject) => {
    // type:'style' 条目注入样式表（onboarding 等 UI 覆盖层的 css 懒加载）。
    if (entry.type === 'style') {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = entry.src;
      link.dataset.rendererFeature = entry.src;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`renderer feature style failed: ${entry.src}`));
      (document.head || document.documentElement).appendChild(link);
      return;
    }
    const script = document.createElement('script');
    script.src = entry.src;
    script.async = false;
    script.dataset.rendererFeature = entry.src;
    script.onload = () => resolve();
    script.onerror = () => {
      if (entry.optional) {
        resolve();
        return;
      }
      reject(new Error(`renderer feature script failed: ${entry.src}`));
    };
    (document.head || document.documentElement).appendChild(script);
  });
  _rendererScriptLoads.set(entry.src, run);
  run.catch(() => {
    if (_rendererScriptLoads.get(entry.src) === run) _rendererScriptLoads.delete(entry.src);
  });
  return run;
}

/** Load a tab-only feature exactly once. Concurrent callers share the same
 *  promise, and manifest order is retained for classic-script lexical refs. */
function loadRendererFeature(name) {
  const feature = String(name || '');
  const entries = _rendererFeatureManifest[feature];
  if (!entries) return Promise.reject(new Error(`unknown renderer feature: ${feature}`));
  const existing = _rendererFeatureLoads.get(feature);
  if (existing) return existing;
  const run = (async () => {
    for (const entry of entries) await _appendRendererFeatureScript(entry);
  })();
  _rendererFeatureLoads.set(feature, run);
  run.catch(() => {
    if (_rendererFeatureLoads.get(feature) === run) _rendererFeatureLoads.delete(feature);
  });
  return run;
}

window.loadRendererFeature = loadRendererFeature;

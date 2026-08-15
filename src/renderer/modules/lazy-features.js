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
  ],
  marketplace: [
    { src: './modules/marketplace.js' },
  ],
  agents: [],
  auto: [
    { src: './modules/auto.js' },
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
    { src: './modules/skills.js' },
    { src: './modules/skills-bindings.js' },
  ],
  recall: [
    { src: './modules/recall-information-architecture.js' },
    { src: './modules/skills.js' },
    { src: './modules/skills-bindings.js' },
    { src: './modules/personal-ontology.js' },
  ],
  'personal-ontology': [
    { src: './modules/cognition/pages.js' },
    { src: './modules/cognition/cognition.js' },
    { src: './modules/personal-context-review.js' },
    { src: './modules/personal-ontology.js' },
  ],
  spaces: [
    { src: './modules/spaces.js' },
  ],
  workspace: [
    { src: './modules/workspace.js' },
  ],
});

const _rendererFeatureLoads = new Map();
const _rendererScriptLoads = new Map();

function _appendRendererFeatureScript(entry) {
  const existing = _rendererScriptLoads.get(entry.src);
  if (existing) return existing;
  const run = new Promise((resolve, reject) => {
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

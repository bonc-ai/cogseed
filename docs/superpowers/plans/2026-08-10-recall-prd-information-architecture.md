# Recall PRD Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Simplify the Recall inner page from nine technical/product-mixed tabs into the three PRD-aligned user entry points “总览、认知沉淀、能力资产”, while keeping workspaces and connections unchanged and using one four-category taxonomy across candidates and formal assets.

**Architecture:** Keep the existing Recall snapshot and IPC contracts. Add a small pure renderer information-architecture helper that normalizes the three new page locations, maps legacy page ids to nested views, and maps legacy candidate types into the four user-facing categories. Recompose the existing renderer functions inside three static page shells rather than changing backend storage or adding new IPC channels.

**Tech Stack:** Electron renderer classic scripts, vanilla HTML/CSS/JS, existing `skills.js` / `skills-bindings.js`, JSON i18n locales, Vitest via `node scripts/run-tests.mjs`.

---

## File map and responsibilities

### Create

- `src/renderer/modules/recall-information-architecture.js`
  - Pure, dependency-free route and category normalization for the Recall page.
  - Exposes a guarded CommonJS bridge for tests and a `window.RecallInformationArchitecture` global for classic scripts.
- `test/renderer/recall-information-architecture.test.ts`
  - Tests the route migration table and the four-category normalization table.

### Modify

- `src/renderer/index.html`
  - Replace the nine top-level Recall tabs/page shells with three main page shells and nested deposition controls.
- `src/renderer/modules/lazy-features.js`
  - Load `recall-information-architecture.js` before `skills.js` for both the `recall` and `skills` lazy feature bundles.
- `src/renderer/modules/skills.js`
  - Store the normalized main page, deposition subview, candidate category, and asset category.
  - Recompose overview, deposition, and ability-asset rendering without changing IPC calls.
  - Replace technical labels with the PRD user vocabulary.
- `src/renderer/modules/skills-bindings.js`
  - Bind the new main tabs, deposition subviews, candidate category filters, and legacy deep-link normalization.
- `src/renderer/modules/journey.js`
  - Point existing Recall journey nodes to normalized nested views while retaining the same user action targets.
- `src/renderer/style.css`
  - Style the three-level information hierarchy, compact subview/category controls, merged asset detail, and narrow-screen list/detail navigation.
- `src/renderer/locales/en.json`
- `src/renderer/locales/zh.json`
- `src/renderer/locales/ja.json`
- `src/renderer/locales/pt.json`
  - Add canonical labels and status copy; leave unrelated legacy aliases intact for other surfaces.
- `test/renderer/skills-cognition-layout.test.ts`
  - Update structural assertions for three main tabs and nested views.
- `test/renderer/recall-cognition-flow.test.ts`
  - Add coverage for normalized page routing, deposition subviews, and unified category filters.
- `test/renderer/skills-frontmatter.test.ts`
  - Extend category assertions to candidates and formal assets using the same four-category helper.

### Do not modify

- Backend Recall/KSTAR storage, candidate-generation rules, asset promotion rules, IPC channel names, or data schemas.
- Existing workspace and connector pages.

---

### Task 1: Add the pure Recall information-architecture contract

**Files:**
- Create: `src/renderer/modules/recall-information-architecture.js`
- Create: `test/renderer/recall-information-architecture.test.ts`

- [ ] **Step 1: Write the failing route and category tests**

Add tests for the exact public contract:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeRecallLocation, normalizeAbilityCategory } from '../../src/renderer/modules/recall-information-architecture';

describe('Recall information architecture', () => {
  it.each([
    ['overview', { page: 'overview', subview: '' }],
    ['sources', { page: 'deposition', subview: 'sources' }],
    ['captures', { page: 'deposition', subview: 'captures' }],
    ['candidates', { page: 'deposition', subview: 'candidates' }],
    ['assets', { page: 'assets', subview: 'list' }],
    ['brain', { page: 'assets', subview: 'tree' }],
    ['context', { page: 'assets', subview: 'reuse' }],
    ['ontology', { page: 'assets', subview: 'list', category: 'personal' }],
    ['receipts', { page: 'assets', subview: 'reuse' }],
    ['not-a-real-page', { page: 'overview', subview: '' }],
  ])('maps legacy page %s into the new location', (legacy, expected) => {
    expect(normalizeRecallLocation(legacy)).toMatchObject(expected);
  });

  it.each([
    ['personal', 'personal'],
    ['preference', 'personal'],
    ['ontology', 'personal'],
    ['rule', 'rule'],
    ['template', 'template'],
    ['skill_method', 'skill_method'],
    ['skill_evolution', 'skill_method'],
    ['experience', 'skill_method'],
    ['evaluation', ''],
    ['', ''],
  ])('normalizes legacy type %s into the four-category contract', (value, expected) => {
    expect(normalizeAbilityCategory(value)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-information-architecture.test.ts --reporter=verbose
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the minimal helper**

Implement the classic-script/CommonJS-compatible module with this public shape:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RecallInformationArchitecture = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CATEGORY_ORDER = Object.freeze(['personal', 'rule', 'template', 'skill_method']);

  function normalizeRecallLocation(page) {
    const value = String(page || '').trim();
    if (value === 'sources' || value === 'captures' || value === 'candidates') {
      return { page: 'deposition', subview: value };
    }
    if (value === 'brain') return { page: 'assets', subview: 'tree' };
    if (value === 'context' || value === 'receipts') return { page: 'assets', subview: 'reuse' };
    if (value === 'ontology') return { page: 'assets', subview: 'list', category: 'personal' };
    if (value === 'assets') return { page: 'assets', subview: 'list' };
    if (value === 'deposition') return { page: 'deposition', subview: 'candidates' };
    return { page: 'overview', subview: '' };
  }

  function normalizeAbilityCategory(value) {
    const category = String(value || '').trim();
    if (category === 'personal' || category === 'preference' || category === 'ontology') return 'personal';
    if (category === 'rule') return 'rule';
    if (category === 'template') return 'template';
    if (category === 'skill_method' || category === 'skill_evolution' || category === 'experience') return 'skill_method';
    return '';
  }

  return Object.freeze({ CATEGORY_ORDER, normalizeRecallLocation, normalizeAbilityCategory });
});
```

Do not put i18n strings in this helper; it only handles stable ids.

- [ ] **Step 4: Run the test to verify it passes**

Run the same command. Expected: all route and category cases PASS.

- [ ] **Step 5: Commit the isolated contract**

```bash
git add src/renderer/modules/recall-information-architecture.js test/renderer/recall-information-architecture.test.ts
git commit -m "test: define Recall information architecture contract"
```

---

### Task 2: Replace the nine-tab HTML shell with three main pages

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `test/renderer/skills-cognition-layout.test.ts`

- [ ] **Step 1: Add failing structural assertions**

Extend the layout test to require exactly the three main page buttons and reject technical top-level buttons:

```ts
expect(surfaceHtml).toContain('data-cognition-page="overview"');
expect(surfaceHtml).toContain('data-cognition-page="deposition"');
expect(surfaceHtml).toContain('data-cognition-page="assets"');
expect(surfaceHtml).not.toContain('data-cognition-page="brain"');
expect(surfaceHtml).not.toContain('data-cognition-page="context"');
expect(surfaceHtml).not.toContain('data-cognition-page="ontology"');
expect(surfaceHtml).not.toContain('data-cognition-page="receipts"');
expect(surfaceHtml).toContain('data-cognition-deposition-view="candidates"');
expect(surfaceHtml).toContain('data-cognition-deposition-view="captures"');
expect(surfaceHtml).toContain('data-cognition-deposition-view="sources"');
```

- [ ] **Step 2: Run the layout test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: FAIL against the existing nine-button HTML.

- [ ] **Step 3: Replace the static navigation and page shells**

In `index.html`, replace the current three `.skills-cognition-tab-group` blocks with:

```html
<nav class="skills-cognition-tabs" id="skills-cognition-tabs" aria-label="Recall 导航" role="tablist">
  <button type="button" class="skills-cognition-tab is-active" data-cognition-page="overview" role="tab" aria-selected="true">
    <span data-ui-icon="layout-grid"></span><span data-i18n="cognition.overview">总览</span>
  </button>
  <button type="button" class="skills-cognition-tab" data-cognition-page="deposition" role="tab" aria-selected="false">
    <span data-ui-icon="sparkles"></span><span data-i18n="cognition.deposition">认知沉淀</span><span class="cognition-nav-count" data-cognition-count="pending"></span>
  </button>
  <button type="button" class="skills-cognition-tab" data-cognition-page="assets" role="tab" aria-selected="false">
    <span data-ui-icon="archive"></span><span data-i18n="cognition.ability_assets">能力资产</span><span class="cognition-nav-count" data-cognition-count="assets"></span>
  </button>
</nav>
```

Keep exactly three top-level page bodies. Put the existing source, capture, and candidate hosts inside the deposition page under three nested view bodies:

```html
<section class="skills-cognition-page" id="skills-cognition-deposition" data-cognition-page-body="deposition" hidden>
  <div class="recall-subtabs" id="skills-cognition-deposition-tabs" role="tablist">
    <button type="button" data-cognition-deposition-view="candidates" role="tab"><span data-i18n="cognition.pending_knowledge">待确认认知</span></button>
    <button type="button" data-cognition-deposition-view="captures" role="tab"><span data-i18n="cognition.organize_tasks">整理任务</span></button>
    <button type="button" data-cognition-deposition-view="sources" role="tab"><span data-i18n="cognition.sources">认知来源</span></button>
  </div>
  <section data-cognition-deposition-body="candidates"><div id="skills-cognition-candidates-body"></div></section>
  <section data-cognition-deposition-body="captures" hidden><div id="skills-cognition-captures-body"></div></section>
  <section data-cognition-deposition-body="sources" hidden><div id="skills-cognition-sources-body"></div></section>
</section>
```

Keep only one asset host in the assets page. The old `brain`, `context`, `ontology`, and `receipts` page bodies must not remain as top-level page bodies; their data will be rendered as sections/detail later.

Add the new helper before `skills.js` and `skills-bindings.js` in both `recall` and `skills` lazy bundles:

```js
recall: [
  { src: './modules/recall-information-architecture.js' },
  { src: './modules/skills.js' },
  { src: './modules/skills-bindings.js' },
],
```

- [ ] **Step 4: Run the layout test to verify it passes**

Run the same test. Expected: PASS, with no more than three `data-cognition-page` main buttons.

- [ ] **Step 5: Commit the shell change**

```bash
git add src/renderer/index.html src/renderer/modules/lazy-features.js test/renderer/skills-cognition-layout.test.ts
git commit -m "refactor: consolidate Recall page navigation"
```

---

### Task 3: Normalize main-page and nested-view state/bindings

**Files:**
- Modify: `src/renderer/modules/skills.js:18-129, 950-1030`
- Modify: `src/renderer/modules/skills-bindings.js:63-150`
- Modify: `test/renderer/recall-cognition-flow.test.ts`

- [ ] **Step 1: Add failing state/routing tests**

Add a renderer integration case that loads the new helper and asserts legacy links resolve to the correct new page and nested view. The test must verify that clicking an old `data-cognition-page-link="candidates"` no longer attempts to activate a removed top-level page.

```ts
expect(normalizeRecallLocation('candidates')).toEqual({ page: 'deposition', subview: 'candidates' });
expect(normalizeRecallLocation('receipts')).toEqual({ page: 'assets', subview: 'reuse' });
```

Add a source assertion that the state has `depositionView` and `candidateCategoryFilter`.

- [ ] **Step 2: Run the targeted flow test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts --reporter=verbose
```

Expected: FAIL because the current switcher only allows the nine legacy page ids.

- [ ] **Step 3: Implement normalized state and switching**

Replace the page state fields with:

```js
const _skillsCognitionState = {
  page: 'overview',
  depositionView: 'candidates',
  candidateCategoryFilter: '',
  assetSubview: 'list',
  assetCategoryFilter: '',
  // existing loaded data and selection fields remain unchanged
};
```

Make `switchSkillsCognitionPage` normalize legacy ids before updating visibility:

```js
function switchSkillsCognitionPage(page) {
  const ia = window.RecallInformationArchitecture;
  const location = ia ? ia.normalizeRecallLocation(page) : { page: 'overview', subview: '' };
  _skillsCognitionState.page = location.page;
  if (location.page === 'deposition') _skillsCognitionState.depositionView = location.subview || 'candidates';
  if (location.page === 'assets') {
    _skillsCognitionState.assetSubview = location.subview || 'list';
    if (location.category) _skillsCognitionState.assetCategoryFilter = location.category;
  }
  _cognitionSetPageVisibility(location.page);
  _renderCognitionPage(location.page);
}
```

Add a single renderer dispatcher:

```js
function _renderCognitionPage(page) {
  if (page === 'overview') renderSkillsCognitionOverview();
  else if (page === 'deposition') renderSkillsCognitionDeposition();
  else if (page === 'assets') renderSkillsCognitionAssets();
}
```

`renderSkillsCognitionDeposition` must set the nested view visibility and call exactly one of the existing source/capture/candidate renderers. It must not delete or recreate the loaded snapshot.

- [ ] **Step 4: Add binding for main tabs, deposition views, and category filters**

In `skills-bindings.js`, keep the existing idempotent panel binding and add:

```js
document.getElementById('skills-cognition-deposition-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-cognition-deposition-view]');
  if (!button) return;
  _skillsCognitionState.depositionView = button.dataset.cognitionDepositionView || 'candidates';
  renderSkillsCognitionDeposition();
});

panel.addEventListener('click', (event) => {
  const category = event.target.closest('[data-cognition-candidate-category]');
  if (!category) return;
  _skillsCognitionState.candidateCategoryFilter = category.dataset.cognitionCandidateCategory || '';
  renderSkillsCognitionCandidates();
});
```

Update all old page-link calls to go through `switchSkillsCognitionPage`; do not add direct DOM toggles for removed page ids.

- [ ] **Step 5: Run the flow tests to verify they pass**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 6: Commit the state/binding change**

```bash
git add src/renderer/modules/skills.js src/renderer/modules/skills-bindings.js test/renderer/recall-cognition-flow.test.ts
git commit -m "refactor: normalize Recall nested navigation"
```

---

### Task 4: Redesign the overview around PRD value actions

**Files:**
- Modify: `src/renderer/modules/skills.js:636-723`
- Modify: `test/renderer/recall-cognition-flow.test.ts`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`

- [ ] **Step 1: Add failing overview assertions**

Add assertions that overview output contains the PRD user sections and does not expose `RecallView` or `待审 Candidate`:

```ts
expect(overview.innerHTML).toContain('下一步');
expect(overview.innerHTML).toContain('认知沉淀');
expect(overview.innerHTML).toContain('关于我');
expect(overview.innerHTML).toContain('规则与判断');
expect(overview.innerHTML).toContain('模板与范例');
expect(overview.innerHTML).toContain('技能与方法');
expect(overview.innerHTML).not.toContain('RecallView');
expect(overview.innerHTML).not.toContain('待审 Candidate');
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts --reporter=verbose
```

Expected: FAIL because `_renderCognitionPipelineStatus` and the overview stat cards still expose the old vocabulary.

- [ ] **Step 3: Replace the overview composition**

Keep the existing dashboard, source, capture, candidate, asset, and receipt data inputs. Replace the overview output with four user-facing regions:

```js
const nextAction = pendingCandidates.length
  ? `<button class="btn btn-primary btn-sm" data-cognition-page-link="deposition">${escapeHtml(_cognitionText('cognition.review_next', '开始审查'))}</button>`
  : latestCapture
    ? `<button class="btn btn-sm" data-cognition-page-link="deposition">${escapeHtml(_cognitionText('cognition.open_deposition', '查看认知沉淀'))}</button>`
    : `<button class="btn btn-sm" data-cognition-page-link="deposition">${escapeHtml(_cognitionText('cognition.organize_recent', '整理最近工作'))}</button>`;
```

The pipeline labels must be:

```js
const stages = [
  [_cognitionText('cognition.pipeline_sources', '认知来源'), sourceCount],
  [_cognitionText('cognition.pipeline_tasks', '整理任务'), captureCount],
  [_cognitionText('cognition.pipeline_pending', '待确认认知'), pendingCandidates.length],
];
```

The asset summary must use the canonical category ids and labels:

```js
const assets = Array.isArray(_skillsCognitionState.assets) ? _skillsCognitionState.assets : [];
const normalizeCategory = window.RecallInformationArchitecture.normalizeAbilityCategory;
const categorySummary = ['personal', 'rule', 'template', 'skill_method'].map((category) => ({
  category,
  label: _abilityAssetCategoryLabel(category),
  count: assets.filter((asset) => normalizeCategory(asset.category || asset.type) === category).length,
}));
```

Use user-facing empty states and preserve links to the new `deposition` and `assets` pages.

- [ ] **Step 4: Add canonical i18n keys in all four renderer locales**

Add the same key set with translated values:

```json
{
  "cognition.product_title": "CogSeed",
  "cognition.product_subtitle": "跨 Agent 的个人能力资产层",
  "cognition.deposition": "认知沉淀",
  "cognition.ability_assets": "能力资产",
  "cognition.pending_knowledge": "待确认认知",
  "cognition.organize_tasks": "整理任务",
  "cognition.pipeline_tasks": "整理任务",
  "cognition.pipeline_pending": "待确认认知",
  "cognition.review_next": "开始审查",
  "cognition.open_deposition": "查看认知沉淀",
  "cognition.organize_recent": "整理最近工作"
}
```

Do not remove existing keys yet; other lazy surfaces may still reference their legacy labels.

- [ ] **Step 5: Run overview and locale tests**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: PASS with no technical pipeline labels in overview.

- [ ] **Step 6: Commit the overview change**

```bash
git add src/renderer/modules/skills.js test/renderer/recall-cognition-flow.test.ts src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json
git commit -m "feat: align Recall overview with CogSeed value actions"
```

---

### Task 5: Merge sources, capture tasks, and candidates into 认知沉淀

**Files:**
- Modify: `src/renderer/modules/skills.js:207-243, 575-635, 725-772`
- Modify: `src/renderer/modules/skills-bindings.js:63-180`
- Modify: `test/renderer/recall-cognition-flow.test.ts`
- Modify: `test/renderer/skills-frontmatter.test.ts`

- [ ] **Step 1: Add failing deposition tests**

Add a candidate render test that asserts the four category chips and a candidate card use the same normalized category:

```ts
_skillsCognitionState.recallCandidates = [{
  id: 'cand-template',
  suggestedType: 'template',
  judgment: 'Use a stable review template',
  summary: 'Review structure',
  status: 'pending',
}];
_skillsCognitionState.candidates = [];
renderSkillsCognitionCandidates();
expect(host.innerHTML).toContain('data-cognition-candidate-category="template"');
expect(host.innerHTML).toContain('模板与范例');
```

Add a deposition switch test asserting only one nested body is visible after selecting `sources`, `captures`, or `candidates`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts test/renderer/skills-frontmatter.test.ts --reporter=verbose
```

Expected: FAIL because candidates have no unified category filter and the three existing renderers are separate pages.

- [ ] **Step 3: Implement `renderSkillsCognitionDeposition`**

Add:

```js
function renderSkillsCognitionDeposition() {
  const view = _skillsCognitionState.depositionView || 'candidates';
  document.querySelectorAll('[data-cognition-deposition-body]').forEach((el) => {
    const active = el.dataset.cognitionDepositionBody === view;
    el.hidden = !active;
  });
  document.querySelectorAll('[data-cognition-deposition-view]').forEach((el) => {
    const active = el.dataset.cognitionDepositionView === view;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (view === 'candidates') renderSkillsCognitionCandidates();
  if (view === 'captures') renderSkillsCognitionCaptures();
  if (view === 'sources') renderSkillsCognitionSources();
}
```

Add category chips to the candidate renderer using `window.RecallInformationArchitecture.CATEGORY_ORDER`, and filter both existing candidate arrays through `window.RecallInformationArchitecture.normalizeAbilityCategory` before rendering. Do not change accept/reject IPC payloads.

```js
const category = window.RecallInformationArchitecture.normalizeAbilityCategory(candidate.suggestedType || candidate.type || candidate.category);
const visible = !filter || category === filter;
```

The candidate card must render the canonical category label, source, uncertainty, suggested scope, and the existing save/edit/defer/reject actions.

Change the pipeline “review candidates” action to link to `data-cognition-page-link="deposition"` and set `depositionView = 'candidates'` through the normalized switcher.

- [ ] **Step 4: Change user-facing capture status copy without changing backend status ids**

Keep backend status values such as `waiting_quiet`, `queued`, and `extracting`. Only change their renderer labels to:

```js
waiting_completion -> 等待会话完成
waiting_quiet -> 等待静默
queued|extracting -> 正在整理
review_ready -> 等待确认
```

Keep detailed technical error explanations in the expanded task detail only.

- [ ] **Step 5: Run the deposition tests**

Run the same command. Expected: PASS.

- [ ] **Step 6: Commit the deposition change**

```bash
git add src/renderer/modules/skills.js src/renderer/modules/skills-bindings.js test/renderer/recall-cognition-flow.test.ts test/renderer/skills-frontmatter.test.ts
git commit -m "feat: merge Recall sources tasks and candidate review"
```

---

### Task 6: Consolidate four asset categories and move technical objects into detail sections

**Files:**
- Modify: `src/renderer/modules/skills.js:244-336, 820-948`
- Modify: `src/renderer/modules/skills-bindings.js:74-82, 114-150`
- Modify: `test/renderer/skills-frontmatter.test.ts`
- Modify: `test/renderer/recall-cognition-flow.test.ts`

- [ ] **Step 1: Add failing asset integration tests**

Add assertions that the assets page exposes exactly four category controls and that the asset detail contains sections for the former technical objects instead of separate page links:

```ts
expect(body.innerHTML).toContain('关于我');
expect(body.innerHTML).toContain('规则与判断');
expect(body.innerHTML).toContain('模板与范例');
expect(body.innerHTML).toContain('技能与方法');
expect(body.innerHTML).not.toContain('data-cognition-page-link="brain"');
expect(body.innerHTML).not.toContain('data-cognition-page-link="ontology"');
expect(body.innerHTML).toContain('认知树');
expect(body.innerHTML).toContain('复用证明');
```

- [ ] **Step 2: Run the asset tests to verify they fail**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/skills-frontmatter.test.ts test/renderer/recall-cognition-flow.test.ts --reporter=verbose
```

Expected: FAIL because current asset detail still links to the removed `receipts` and `candidates` pages and the old Brain/Ontology content is separate.

- [ ] **Step 3: Make category normalization the single renderer source of truth**

Update `_abilityAssetCategoryLabel` to call the helper:

```js
function _abilityAssetCategory(asset) {
  const ia = window.RecallInformationArchitecture;
  return ia ? ia.normalizeAbilityCategory(asset?.category || asset?.type) : (asset?.category || asset?.type || '');
}

function _abilityAssetCategoryLabel(category) {
  const normalized = _abilityAssetCategory({ category });
  const labels = {
    personal: _cognitionText('cognition.asset_category_personal', '关于我'),
    rule: _cognitionText('cognition.asset_category_rule', '规则与判断'),
    template: _cognitionText('cognition.asset_category_template', '模板与范例'),
    skill_method: _cognitionText('cognition.asset_category_skill_method', '技能与方法'),
  };
  return labels[normalized] || _cognitionText('cognition.unknown', '未知');
}
```

Use the same normalized category in summary counts, filter chips, tree branches, list rows, and detail headings.

- [ ] **Step 4: Compose former Brain, Context Pack, Ontology, and Receipt content inside assets**

Refactor existing renderers into reusable HTML-returning helpers where needed; do not duplicate IPC loading:

```js
function renderSkillsCognitionAssets() {
  const assetSummary = _renderAbilityAssetCategorySummary();
  const treeSummary = _renderCognitionTreeSummary();
  const selectedDetail = _renderSelectedAssetDetail();
  const reuseSummary = _renderRecentReuseSummary();
  const minimalPack = _renderSelectedContextPackSummary();
  host.innerHTML = `${assetSummary}${treeSummary}${selectedDetail}${minimalPack}${reuseSummary}`;
}
```

The final page must contain:

- Four category filter chips;
- asset list and selected detail;
- a compact `认知树` summary with four branches;
- `关于我` details sourced from the existing ontology group content when selected;
- a `最小能力包` section sourced from the selected context projection when a reuse record selects one;
- a `复用证明` section or detail drawer sourced from existing receipt data.

No new IPC channels are allowed. Keep existing actions for asset selection, ontology group loading, receipt opening, and asset controls.

- [ ] **Step 5: Update asset detail links**

Replace links to removed top-level pages:

```js
// old
`data-cognition-page-link="receipts"`
`data-cognition-page-link="candidates"`

// new
`data-cognition-open-reuse="${escapeHtml(selected.id)}"`
`data-cognition-page-link="deposition" data-cognition-deposition-target="candidates"
```

The binding must set the appropriate nested view instead of trying to activate a removed main page.

- [ ] **Step 6: Run asset and flow tests**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/skills-frontmatter.test.ts test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 7: Commit the asset consolidation**

```bash
git add src/renderer/modules/skills.js src/renderer/modules/skills-bindings.js test/renderer/skills-frontmatter.test.ts test/renderer/recall-cognition-flow.test.ts
git commit -m "feat: consolidate Recall capability asset categories"
```

---

### Task 7: Align naming, journey links, and renderer accessibility styles

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/journey.js:90-160, 452-475`
- Modify: `src/renderer/modules/skills-bindings.js`
- Modify: `src/renderer/style.css:18146-18680`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `test/renderer/skills-cognition-layout.test.ts`

- [ ] **Step 1: Add failing naming and accessibility assertions**

Assert that the page title/subtitle and canonical category labels exist in each locale, and that main/nested controls expose `role="tab"` plus `aria-selected`.

```ts
expect(surfaceHtml).toContain('data-i18n="cognition.product_title"');
expect(surfaceHtml).toContain('data-i18n="cognition.product_subtitle"');
expect(surfaceHtml).toContain('role="tablist"');
expect(surfaceHtml).toContain('aria-selected="true"');
for (const label of ['cognition.asset_category_personal', 'cognition.asset_category_rule', 'cognition.asset_category_template', 'cognition.asset_category_skill_method']) {
  expect(zh).toContain(`"${label}"`);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: FAIL against old labels, group labels, and journey fallback ids.

- [ ] **Step 3: Update canonical i18n and visible markup**

Use these canonical Chinese values:

```json
{
  "cognition.product_title": "CogSeed",
  "cognition.product_subtitle": "跨 Agent 的个人能力资产层",
  "cognition.overview": "总览",
  "cognition.deposition": "认知沉淀",
  "cognition.ability_assets": "能力资产",
  "cognition.pending_knowledge": "待确认认知",
  "cognition.organize_tasks": "整理任务",
  "cognition.sources": "认知来源",
  "cognition.asset_category_personal": "关于我",
  "cognition.asset_category_rule": "规则与判断",
  "cognition.asset_category_template": "模板与范例",
  "cognition.asset_category_skill_method": "技能与方法",
  "cognition.cognition_tree": "认知树",
  "cognition.minimum_capability_pack": "最小能力包",
  "cognition.reuse_proof": "复用证明"
}
```

Add equivalent English/Japanese/Portuguese translations. Keep old keys as compatibility aliases where other pages still use them, but all Recall inner-page markup must use the canonical keys.

- [ ] **Step 4: Update journey route normalization**

Change journey nodes that currently use `subPage: 'brain'`, `'ontology'`, or `'receipts'` to use the normalized route ids:

```js
{ view: 'recall', subPage: 'assets', assetSubview: 'tree' }
{ view: 'recall', subPage: 'assets', assetSubview: 'list', category: 'personal' }
{ view: 'recall', subPage: 'assets', assetSubview: 'reuse' }
```

Update `_jSwitchRecallPage` to call `switchSkillsCognitionPage(page)` and then apply nested targets through the same normalized helper. Remove its duplicate nine-page fallback list.

- [ ] **Step 5: Add compact nested-control and responsive styles**

Add styles for:

```css
.recall-subtabs { display: flex; gap: 6px; margin-bottom: 16px; overflow-x: auto; }
.recall-subtab { ... }
.recall-subtab.is-active { ... }
.cognition-category-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.cognition-category-filter.is-active { ... }
.cognition-nav-count { ... }
```

Use existing design tokens and buttons. At `max-width: 1100px`, keep horizontal scrolling for tabs; at narrow widths, switch asset detail from two columns to one column and retain an explicit back control.

Add visible focus styles and use `aria-current`/`aria-selected` consistently. Do not use color alone for category or status.

- [ ] **Step 6: Run naming/layout tests**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/skills-cognition-layout.test.ts test/renderer/recall-cognition-flow.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 7: Commit naming and style alignment**

```bash
git add src/renderer/index.html src/renderer/modules/journey.js src/renderer/modules/skills-bindings.js src/renderer/style.css src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json test/renderer/skills-cognition-layout.test.ts
git commit -m "feat: align Recall naming and responsive navigation"
```

---

### Task 8: Preserve legacy routes and verify the complete renderer flow

**Files:**
- Modify: `src/renderer/modules/skills.js`
- Modify: `src/renderer/modules/skills-bindings.js`
- Modify: `src/renderer/modules/journey.js`
- Modify: `test/renderer/recall-cognition-flow.test.ts`
- Modify: `test/renderer/skills-cognition-layout.test.ts`

- [ ] **Step 1: Add compatibility regression tests**

Cover every old location and assert the resulting main page/subview/category:

```ts
const legacy = ['overview', 'sources', 'captures', 'candidates', 'brain', 'context', 'ontology', 'receipts', 'assets'];
for (const page of legacy) {
  const location = normalizeRecallLocation(page);
  expect(['overview', 'deposition', 'assets']).toContain(location.page);
}
```

Also assert:

- old page links do not create visible missing-page state;
- `data-cognition-deposition-target="candidates"` opens the candidate subview;
- an old `ontology` link opens assets filtered to `personal`;
- a receipt deep-link opens the reuse section;
- refresh preserves the normalized location and active filter.

- [ ] **Step 2: Run the compatibility tests to verify they fail if a route is missed**

Run:

```bash
node scripts/run-tests.mjs run test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts --reporter=verbose
```

Expected: PASS after all legacy paths are routed through the helper; if a mapping is missing, the failing case identifies the exact legacy id.

- [ ] **Step 3: Implement the final route/refresh guard**

Persist only the normalized renderer state during the active page lifetime. When a legacy target arrives, normalize once and set:

```js
function openRecallTarget(page, options = {}) {
  const location = window.RecallInformationArchitecture.normalizeRecallLocation(page);
  _skillsCognitionState.page = location.page;
  if (location.page === 'deposition') {
    _skillsCognitionState.depositionView = options.depositionView || location.subview || _skillsCognitionState.depositionView;
  }
  if (location.page === 'assets') {
    _skillsCognitionState.assetSubview = options.assetSubview || location.subview || _skillsCognitionState.assetSubview;
    if (options.category || location.category) _skillsCognitionState.assetCategoryFilter = options.category || location.category;
  }
  _renderCognitionPage(_skillsCognitionState.page);
}
```

Do not persist an old page id after migration.

- [ ] **Step 4: Run the renderer regression set**

Run:

```bash
node scripts/run-tests.mjs run \
  test/renderer/recall-information-architecture.test.ts \
  test/renderer/skills-cognition-layout.test.ts \
  test/renderer/recall-cognition-flow.test.ts \
  test/renderer/skills-frontmatter.test.ts \
  test/renderer/recall-projection-card.test.ts \
  --reporter=verbose
```

Expected: all listed test files pass. Existing projection-card behavior must remain unchanged.

- [ ] **Step 5: Commit the compatibility layer**

```bash
git add src/renderer/modules/skills.js src/renderer/modules/skills-bindings.js src/renderer/modules/journey.js test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts
git commit -m "test: preserve Recall navigation compatibility"
```

---

### Task 9: Final verification and runtime check

**Files:**
- No new product files.
- Review all files changed by Tasks 1–8.

- [ ] **Step 1: Run formatting and diff checks**

```bash
git diff --check develop...HEAD
git status --short --branch
```

Expected: no whitespace errors. The only allowed untracked path is the pre-existing `.worktrees/` directory.

- [ ] **Step 2: Run the complete targeted Recall renderer suite**

```bash
npm run test:js -- --run \
  test/renderer/recall-information-architecture.test.ts \
  test/renderer/skills-cognition-layout.test.ts \
  test/renderer/recall-cognition-flow.test.ts \
  test/renderer/skills-frontmatter.test.ts \
  test/renderer/recall-projection-card.test.ts \
  --reporter=verbose
```

Expected: exit code `0`, all targeted test files passing.

- [ ] **Step 3: Run the existing Recall/KSTAR backend regression set**

```bash
node scripts/run-tests.mjs run \
  test/main/features/recall/context-projection-confirm-wake.test.ts \
  test/main/features/recall/projection-card.test.ts \
  test/main/features/recall/projection-message.test.ts \
  test/main/features/kstar/lifecycle-adapter.test.ts \
  test/main/features/kstar/requirement-state.test.ts \
  --reporter=verbose
```

Expected: exit code `0`; no backend data or IPC contract regressions.

- [ ] **Step 4: Restart the current worktree runtime**

Run:

```bash
scripts/restart-mate.sh
```

Confirm startup in:

- `/tmp/mate-agent-mate-run.log`
- `/Users/sudai/.orkas/runtime-variants/mate/data/logs/<date>.log`

Expected: app boot, renderer boot, and no startup error.

- [ ] **Step 5: Perform manual visual QA**

Open Recall and verify:

1. Main navigation contains only 总览、认知沉淀、能力资产。
2. 认知沉淀 contains 待确认认知、整理任务、认知来源.
3. Candidate and asset filters use the same four categories and order.
4. The page no longer exposes Brain, Context Pack, Ontology, RecallView, or Candidate as top-level user labels.
5. Asset detail contains 认知树、最小能力包 and 复用证明 sections where data exists.
6. Empty, loading, failure, and narrow-screen states remain usable.
7. Existing candidate accept/reject/edit and asset controls still work.

- [ ] **Step 6: Commit only verification artifacts if required**

Do not create a code commit for manual QA notes. If a real defect is found, add a focused failing test and return to the relevant task rather than patching without coverage.

---

## Verification summary

The implementation is ready to call complete only when:

- all targeted renderer and backend regression commands exit `0`;
- `git diff --check` exits `0`;
- the runtime restarts from the current worktree;
- the final visual checklist passes;
- no backend schema or IPC changes were introduced for this UI-only consolidation.

# CogSeed Brand and Cognition Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** On `dev/remove-meta-skill-evolution-b-prime`, finish the frontend navigation cleanup and apply the safe user-visible Mate Agent → CogSeed brand transition without changing internal compatibility identifiers.

**Architecture:** Keep the existing renderer routes, contexts backend, Recall feature namespace, Commander actor, IPC channels, App ID, protocol schemes, and data paths. Change only renderer-visible navigation labels/entries, reuse the existing contexts view from Settings, keep the target worktree’s already-completed Evolution Console frontend removal, and centralize the public brand name through `src/resources/brand.json` plus the existing brand reader.

**Tech Stack:** Electron main process, classic renderer JavaScript/HTML/CSS, JSON locales, `window.orkas.invoke`, npm/electron-builder metadata, Vitest through `npm run test:js`, full verification through `npm test`.

---

## File map

### Navigation and Settings

- Modify `src/renderer/index.html`
  - Keep the sidebar without `contexts-btn`, `evolution-btn`, and the Evolution topbar control (already removed in this worktree).
  - Keep the existing Settings panel and add/retain one `settings-contexts-open-btn` row.
  - Change visible sidebar i18n keys only; do not rename `new-chat-btn`, `recall-btn`, or internal view ids.
- Modify `src/renderer/modules/settings.js`
  - Ensure the Settings → 资料库 button is bound exactly once and calls `setView('contexts')`.
  - Bind it from the existing Settings render/init path, not by adding a second renderer or IPC call.
- Modify `src/renderer/modules/boot.js`
  - Keep `contexts` as a valid internal view.
  - Keep the existing `evolution` legacy fallback to `skills` and ensure no deleted Evolution panel is referenced.
- Modify `src/renderer/modules/state.js`
  - Confirm no deleted `contexts-btn`/Evolution event bindings remain.
  - Keep `new-chat-btn` and `recall-btn` behavior unchanged.
- Modify `src/renderer/modules/settings_tabs.js` only if the Settings entry requires a dedicated pane/tab rather than the existing local Settings surface.
- Modify `test/renderer/settings-contexts-entry.test.ts`
  - Assert no primary Library entry, one Settings entry, and exact `setView('contexts')` reuse.
- Modify/create renderer navigation tests for the visible labels and deleted Evolution entry.

### Recall / cognition visible naming

- Modify `src/renderer/locales/en.json`, `zh.json`, `ja.json`, `pt.json`
  - `sidebar.new_chat` becomes the localized “New session” / “新建会话” label.
  - `sidebar.recall` becomes the localized “Cognitive assets” / “认知资产” label.
  - Ensure Recall inner-page canonical keys use CogSeed, 总览, 认知沉淀, 能力资产.
  - Keep legacy backend/status aliases intact where other surfaces still consume them.
- Modify `src/renderer/index.html` only where fallback visible text is hard-coded; primary text must remain `data-i18n` driven.
- Review `src/renderer/modules/skills.js`, `src/renderer/modules/skills-bindings.js`, and `src/renderer/modules/journey.js` for hard-coded Recall labels or stale evolution links; change visible labels/routes only, preserve IPC payloads.
- Modify/add `test/renderer/recall-cognition-flow.test.ts`, `test/renderer/skills-cognition-layout.test.ts`, and `test/renderer/sidebar-branding.test.ts` for the visible naming contract.

### CogSeed public brand layer

- Modify `src/resources/brand.json`
  - Set public `appName` and `zhName` to `CogSeed`.
  - Keep `appId`, `protocolScheme`, and `legacyConnectorScheme` unchanged.
  - Update the public tagline to the approved CogSeed cognition value proposition.
- Modify `src/main/brand.ts` only if the existing reader needs a new public tagline field; do not add a second brand source.
- Modify `package.json`
  - Update description/productName/protocol display name/artifact name where they are user-visible.
  - Keep `build.appId`, `brand.protocolScheme`, and `brand.legacyConnectorScheme` unchanged.
- Modify `run.sh`, `run.cmd`, and `bootstrap.cjs`
  - Update visible launcher prefixes, error messages, bundle display name, and source-runtime app bundle path to CogSeed where the product name is user-visible.
  - Keep `ORKAS_RUNTIME_VARIANT=mate`, the mate data root, and compatibility environment variables unchanged.
- Modify `README.md`, `docs/README.md`, and user-facing product docs only for current product naming; retain an explicit historical compatibility note when a Mate Agent reference is needed.
- Modify `test/main/brand.test.ts`, `test/main/util/source-branding.test.ts`, and any package/launcher tests to assert CogSeed public identity and preserved compatibility identifiers.

### Existing Evolution removal

- Do not re-delete or rewrite the Evolution removal already present in this worktree.
- Preserve `test/renderer/boot-evolution.test.ts`, `topbar-evolution.test.ts`, and `lazy-features-evolution.test.ts` as regression tests for the deleted frontend.
- Run those tests after navigation changes to catch accidental reintroduction.

---

## Task 1: Lock the navigation contract with failing tests

**Files:**
- Modify `test/renderer/settings-contexts-entry.test.ts`
- Create or modify a renderer navigation contract test under `test/renderer/`

- [ ] **Step 1: Add assertions for the requested visible navigation**

Assert the HTML uses the existing internal ids but the requested locale keys:

```ts
expect(html).toContain('id="new-chat-btn"');
expect(html).toContain('data-i18n="sidebar.new_chat"');
expect(html).toContain('id="recall-btn"');
expect(html).toContain('data-i18n="sidebar.recall"');
expect(html).not.toContain('id="contexts-btn"');
expect(html).not.toContain('id="evolution-btn"');
expect(html).not.toContain('id="topbar-evolution-toggle"');
expect(html).not.toContain('id="panel-evolution"');
```

Assert the locale values are the visible names:

```ts
const zh = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));
expect(zh['sidebar.new_chat']).toBe('新建会话');
expect(zh['sidebar.recall']).toBe('认知资产');
```

- [ ] **Step 2: Run the focused test and verify it fails against old labels**

Run:

```bash
npm run test:js -- test/renderer/settings-contexts-entry.test.ts test/renderer/sidebar-navigation-contract.test.ts
```

Expected: failure on the old `指挥官` and `Recall` locale values if those values have not been changed yet.

- [ ] **Step 3: Commit only the red tests**

```bash
git add test/renderer/settings-contexts-entry.test.ts test/renderer/sidebar-navigation-contract.test.ts
git commit -m "test: lock CogSeed navigation labels"
```

## Task 2: Finish the Settings-owned Library entry

**Files:**
- Modify `src/renderer/modules/settings.js`
- Modify `src/renderer/index.html` if the current Settings row needs markup correction
- Modify `test/renderer/settings-contexts-entry.test.ts`

- [ ] **Step 1: Verify the existing binding path**

The Settings render path must call `_settingsBindContextsEntryOnce()` after the Settings DOM exists. Keep the binding shape:

```js
function _settingsBindContextsEntryOnce() {
  const btn = document.getElementById('settings-contexts-open-btn');
  if (!btn || btn.dataset.bound) return;
  btn.addEventListener('click', () => {
    if (typeof setView === 'function') setView('contexts');
  });
  btn.dataset.bound = '1';
}
```

If the existing Settings init/render function does not call it, add exactly one call there. Do not add `contexts` IPC calls or duplicate the contexts renderer.

- [ ] **Step 2: Keep compatibility routing**

Confirm `src/renderer/modules/boot.js` still maps `contexts` to `panel-contexts` and that legacy `evolution` routes fall back to `skills`. Do not remove `contexts` from the internal view map.

- [ ] **Step 3: Run Settings navigation tests**

Run:

```bash
npm run test:js -- test/renderer/settings-contexts-entry.test.ts test/renderer/settings-open.test.ts test/renderer/settings-tabs.test.ts
```

Expected: PASS, with the existing contexts page still reachable from Settings.

- [ ] **Step 4: Commit the Library entry move**

```bash
git add src/renderer/index.html src/renderer/modules/settings.js src/renderer/modules/boot.js src/renderer/modules/state.js test/renderer/settings-contexts-entry.test.ts
git commit -m "feat: move Library entry into Settings"
```

## Task 3: Apply visible Recall and new-session naming

**Files:**
- Modify `src/renderer/locales/en.json`
- Modify `src/renderer/locales/zh.json`
- Modify `src/renderer/locales/ja.json`
- Modify `src/renderer/locales/pt.json`
- Review/modify `src/renderer/modules/skills.js`, `src/renderer/modules/skills-bindings.js`, `src/renderer/modules/journey.js`
- Modify renderer cognition/navigation tests

- [ ] **Step 1: Set the canonical visible locale values**

Use these values for the sidebar keys:

```json
{
  "sidebar.new_chat": {
    "zh": "新建会话",
    "en": "New session",
    "ja": "新しいセッション",
    "pt": "Nova sessão"
  },
  "sidebar.recall": {
    "zh": "认知资产",
    "en": "Cognitive assets",
    "ja": "認知アセット",
    "pt": "Ativos cognitivos"
  }
}
```

Use the existing PRD keys for the Recall page title and three main pages, with Chinese values:

```json
{
  "cognition.product_title": "CogSeed",
  "cognition.product_subtitle": "跨 Agent 的个人能力资产层",
  "cognition.overview": "总览",
  "cognition.deposition": "认知沉淀",
  "cognition.ability_assets": "能力资产"
}
```

- [ ] **Step 2: Remove stale visible wording without renaming internal identifiers**

Search the renderer for literal `Commander`, `Recall`, and old evolution labels. Replace only user-facing text or locale keys. Keep `commander`, `recall`, `contexts`, and `evolution` compatibility ids where required by existing routes/tests.

- [ ] **Step 3: Run renderer cognition/navigation tests**

Run:

```bash
npm run test:js -- test/renderer/recall-information-architecture.test.ts test/renderer/recall-cognition-flow.test.ts test/renderer/skills-cognition-layout.test.ts test/renderer/sidebar-navigation-contract.test.ts
```

Expected: PASS, including the three PRD pages and legacy route normalization.

- [ ] **Step 4: Commit visible Cognition naming**

```bash
git add src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json src/renderer/modules/skills.js src/renderer/modules/skills-bindings.js src/renderer/modules/journey.js test/renderer
git commit -m "feat: rename Recall surface to Cognition Assets"
```

## Task 4: Change the public brand to CogSeed safely

**Files:**
- Modify `src/resources/brand.json`
- Modify `src/main/brand.ts` only if needed
- Modify `package.json`
- Modify `run.sh`
- Modify `run.cmd`
- Modify `bootstrap.cjs`
- Modify `README.md`, `docs/README.md`, and selected public docs
- Modify `test/main/brand.test.ts`
- Modify `test/main/util/source-branding.test.ts`
- Modify package/launcher tests that assert the old public name

- [ ] **Step 1: Update the centralized brand contract**

Set the public values while preserving compatibility fields:

```json
{
  "appName": "CogSeed",
  "zhName": "CogSeed",
  "appId": "com.mateagent.desktop",
  "protocolScheme": "mateagent",
  "legacyConnectorScheme": "orkas",
  "taglineZh": "跨 Agent 的个人能力资产层"
}
```

Keep all consumers reading through `APP_BRAND`; do not add literal CogSeed constants to feature code.

- [ ] **Step 2: Update package and launcher-visible names**

Change the user-visible package/build fields to CogSeed, including the product name, description, protocol display name, artifact name, launcher prefixes, and macOS bundle path. Keep `build.appId` and protocol schemes unchanged. Keep runtime variant `mate` and mate data-root paths unchanged.

- [ ] **Step 3: Update documentation and public locale strings**

Replace current-product references in README/docs and the user-visible locale keys for account, brand, notifications, marketplace, settings, messaging, and status copy. Do not replace internal compatibility mentions such as `@Mate Agent` unless they are explicitly a displayed current product name; leave a short historical note where needed.

- [ ] **Step 4: Update brand tests before implementation assertions**

Change the brand contract tests to assert:

```ts
expect(brand.appName).toBe('CogSeed');
expect(brand.zhName).toBe('CogSeed');
expect(brand.appId).toBe('com.mateagent.desktop');
expect(brand.protocolScheme).toBe('mateagent');
expect(brand.legacyConnectorScheme).toBe('orkas');
expect(pkg.build.productName).toBe('CogSeed');
```

Keep the existing tests that protect `.orkas`, `window.orkas`, and the shared App ID.

- [ ] **Step 5: Run brand tests**

Run:

```bash
npm run test:js -- test/main/brand.test.ts test/main/util/source-branding.test.ts test/main/util/packaged-resource-gate.test.ts test/scripts/verify-packaged-dev.test.ts
```

Expected: PASS with CogSeed public output and old compatibility identifiers intact.

- [ ] **Step 6: Commit the safe brand layer**

```bash
git add src/resources/brand.json src/main/brand.ts package.json run.sh run.cmd bootstrap.cjs README.md docs/README.md src/renderer/locales test/main/brand.test.ts test/main/util/source-branding.test.ts test/main/util/packaged-resource-gate.test.ts test/scripts/verify-packaged-dev.test.ts
git commit -m "feat: rebrand public product surfaces as CogSeed"
```

## Task 5: Full regression verification and target-worktree launch

**Files:**
- Review all changed files; no new feature files expected.

- [ ] **Step 1: Run static checks**

```bash
git diff --check
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 2: Run focused navigation, cognition, brand, and Evolution-removal tests**

```bash
npm run test:js -- \
  test/renderer/settings-contexts-entry.test.ts \
  test/renderer/settings-open.test.ts \
  test/renderer/settings-tabs.test.ts \
  test/renderer/recall-information-architecture.test.ts \
  test/renderer/recall-cognition-flow.test.ts \
  test/renderer/skills-cognition-layout.test.ts \
  test/renderer/sidebar-navigation-contract.test.ts \
  test/renderer/boot-evolution.test.ts \
  test/renderer/topbar-evolution.test.ts \
  test/renderer/lazy-features-evolution.test.ts \
  test/main/brand.test.ts \
  test/main/util/source-branding.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 3: Run the complete suite**

```bash
npm test
```

Expected: zero failed tests; real external CLI tests may remain explicitly skipped.

- [ ] **Step 4: Start and verify the correct worktree**

From `/Users/sudai/.config/codex/worktrees/Mate Agent/remove-meta-skill-evolution-b-prime`:

```bash
scripts/restart-mate.sh
ps -Ao pid,lstart,command | grep -- '--orkas-runtime-variant=mate' | grep -v grep
```

Expected: the Electron command line contains `remove-meta-skill-evolution-b-prime`, not `/Users/sudai/Documents/Mate Agent`. Check `/Users/sudai/.orkas/runtime-variants/mate/data/logs/2026-08-10.log` and `/tmp/mate-agent-mate-run.log` for CogSeed startup output.

- [ ] **Step 5: Review final diff and commit state**

```bash
git status --short --branch
git diff --check
```

Confirm no compatibility identifiers were accidentally changed and no deleted Evolution frontend entry returned.

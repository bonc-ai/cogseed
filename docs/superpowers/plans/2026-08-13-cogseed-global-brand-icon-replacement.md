# CogSeed Global Brand Icon Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax to track progress via update_plan.

**Goal:** Replace all user-visible CogSeed brand icon assets and desktop application icon containers with the user-approved animal-and-seed logo while preserving product identity, protocols, and internal compatibility symbols.

**Architecture:** Keep `src/resources/icons` as the single packaged brand-asset boundary. Use the supplied PNG as the source of truth, create a transparent page-logo variant and a light-background app-icon variant, then regenerate PNG/ICO/ICNS/SVG outputs consumed by existing Electron and renderer paths. No business, storage, protocol, or IPC behavior changes.

**Tech Stack:** Python 3, Pillow, existing SVG/ICO/ICNS asset pipeline, TypeScript/Vitest, Electron Builder.

---

## File map

- `docs/superpowers/specs/2026-08-13-cogseed-global-brand-icon-replacement-design.md` — approved visual and scope design.
- `scripts/generate-brand-icons.py` — deterministic icon-generation source; replace the old double-node drawing with the supplied logo processing pipeline.
- `src/resources/icons/logo.png` — transparent page/brand logo.
- `src/resources/icons/icon.png` — light-background 512px app icon.
- `src/resources/icons/icon.ico` — Windows multi-size icon regenerated from `icon.png`.
- `src/resources/icons/icon.icns` — macOS multi-size icon regenerated from `icon.png`.
- `src/resources/icons/cogseed-master.svg` — scalable transparent brand mark.
- `test/main/brand-assets.test.ts` — asset dimensions, alpha, file headers, and old-mark exclusion.
- `test/renderer/icons.test.ts` and `test/renderer/sidebar-branding.test.ts` — renderer contract coverage; update only if they assert old visual asset paths or labels.

## Task 1: Add a failing asset contract for the supplied CogSeed mark

**Files:**
- Modify: `test/main/brand-assets.test.ts`
- Modify: `test/main/brand.test.ts` only if the asset contract belongs there

- [ ] **Step 1: Inspect the current asset assertions and add a test for the new visual signature**

Add assertions that load `src/resources/icons/logo.png` and `src/resources/icons/icon.png`, verify RGBA mode, verify the logo has transparent pixels, and verify representative pixels include the approved dark green and orange palette rather than the old purple/blue palette. Also assert that `cogseed-master.svg` does not contain the old double-node path or old purple/blue hex values.

- [ ] **Step 2: Run the focused asset test and verify RED**

```bash
node scripts/run-tests.mjs run test/main/brand-assets.test.ts
```

Expected: the new palette/transparency assertions fail against the existing generated double-node assets.

## Task 2: Implement deterministic source-image processing and generate page/app assets

**Files:**
- Modify: `scripts/generate-brand-icons.py`
- Modify: `src/resources/icons/logo.png`
- Modify: `src/resources/icons/icon.png`
- Modify: `src/resources/icons/cogseed-master.svg`

- [ ] **Step 1: Add the supplied PNG as the generator input without copying it into the repository**

Use `/Users/sudai/Desktop/微信图片_20260813194423_1297_537.png` as a local input path. The generator must fail clearly if the input is unavailable and must not embed the absolute desktop path in generated source files.

- [ ] **Step 2: Implement local background removal and normalization**

In `scripts/generate-brand-icons.py`:

- Read the source as RGBA.
- Treat near-white pixels as background and set their alpha to zero for `logo.png`.
- Preserve anti-aliased edge pixels with a soft alpha transition rather than a hard threshold.
- Crop to the non-transparent bounding box, add symmetric transparent padding, and resize with LANCZOS.
- Create `logo.png` at 1024×1024 RGBA.
- Create `icon.png` at 512×512 RGBA with a light warm-white square background and centered normalized logo.
- Use the approved green/orange colors from the source rather than recoloring the illustration.

- [ ] **Step 3: Replace the old SVG drawing with a matching scalable mark**

Write `cogseed-master.svg` as a transparent SVG using the same green ring, orange character, cream face/belly, green eyes/nose/leaves, and orange seed. Keep the viewBox square and preserve enough padding for sidebar and title-bar use. Do not include the old purple/blue gradient or node paths.

- [ ] **Step 4: Regenerate raster assets and verify dimensions locally**

```bash
python3 scripts/generate-brand-icons.py
file src/resources/icons/logo.png src/resources/icons/icon.png src/resources/icons/cogseed-master.svg
```

Expected:

- `logo.png`: 1024×1024 RGBA
- `icon.png`: 512×512 RGBA
- SVG is readable text and has a square viewBox

## Task 3: Regenerate desktop icon containers

**Files:**
- Modify: `scripts/generate-brand-icons.py`
- Modify: `src/resources/icons/icon.ico`
- Modify: `src/resources/icons/icon.icns`

- [ ] **Step 1: Preserve the existing container-generation contract**

Use the repository’s current generation mechanism and required platform tools. ICO must contain at least the existing 7 sizes. ICNS must have a valid `icns` header and include the standard macOS sizes used by the existing packager.

- [ ] **Step 2: Generate ICO and ICNS from the new app icon**

```bash
python3 scripts/generate-brand-icons.py
```

If the script requires macOS `iconutil`, use it rather than adding a new dependency. Do not hand-edit binary files.

- [ ] **Step 3: Verify binary headers and dimensions**

```bash
node scripts/run-tests.mjs run test/main/brand-assets.test.ts
```

Expected: asset tests pass, including ICO/ICNS header checks and new palette/transparency checks.

## Task 4: Verify all application and renderer references use the shared assets

**Files:**
- Modify only if a stale user-visible asset reference is found:
  - `src/main/index.ts`
  - `src/renderer/index.html`
  - `src/renderer/modules/icons.js`
  - `src/renderer/modules/sidebar-branding.js`
  - relevant CSS or resource manifests
- Test: `test/renderer/icons.test.ts`
- Test: `test/renderer/sidebar-branding.test.ts`

- [ ] **Step 1: Search for old asset paths and old visual identifiers**

```bash
rg -n -i 'cogseed-master|src/resources/icons|logo\.png|icon\.png|purple|blue|double-node|node' src package.json scripts test
```

Classify matches as internal compatibility, unrelated illustrations, or brand assets. Only change stale brand references.

- [ ] **Step 2: Ensure packaged Electron Builder paths remain aligned**

Verify `package.json` still points to:

```json
{
  "mac": { "icon": "src/resources/icons/icon.icns" },
  "win": { "icon": "src/resources/icons/icon.ico" },
  "files": ["src/resources/icons/**/*"]
}
```

No package identity or protocol fields should change.

- [ ] **Step 3: Run renderer brand tests**

```bash
node scripts/run-tests.mjs run test/renderer/icons.test.ts test/renderer/sidebar-branding.test.ts
```

Expected: all renderer brand tests pass and no stale old-logo reference remains in user-visible surfaces.

## Task 5: Visual and packaging verification

**Files:**
- Modify only if verification finds a defect.

- [ ] **Step 1: Render and inspect generated PNG/SVG assets**

Use Pillow/ImageMagick or the workspace image viewer to inspect:

- transparent page logo on light and dark backgrounds;
- 16px, 32px, 64px, 128px, 256px, and 512px app icon previews;
- ring continuity, face details, seed visibility, and edge halos.

- [ ] **Step 2: Run complete brand-focused verification**

```bash
node scripts/run-tests.mjs run \
  test/main/brand.test.ts \
  test/main/brand-assets.test.ts \
  test/renderer/icons.test.ts \
  test/renderer/sidebar-branding.test.ts
npm run typecheck
git diff --check
```

Expected: zero failures, typecheck exit code 0, and no whitespace errors.

- [ ] **Step 3: Inspect final repository state**

```bash
git status --short
git diff --stat HEAD~1
```

Only the approved design document, generator, brand assets, and directly related tests may be staged. Do not stage the existing unrelated DOCX files or p3394 wake tests.

- [ ] **Step 4: Commit the implementation**

```bash
git add scripts/generate-brand-icons.py \
  src/resources/icons/logo.png \
  src/resources/icons/icon.png \
  src/resources/icons/icon.ico \
  src/resources/icons/icon.icns \
  src/resources/icons/cogseed-master.svg \
  test/main/brand-assets.test.ts \
  test/main/brand.test.ts \
  test/renderer/icons.test.ts \
  test/renderer/sidebar-branding.test.ts

git diff --cached --check
git commit -m "feat: replace CogSeed brand icon assets"
```

## Verification summary

The implementation is complete when:

- the supplied animal-and-seed mark is used by page and app assets;
- page logo has transparent background and app icon has light background;
- PNG/SVG/ICO/ICNS assets are valid and packaged through existing paths;
- old purple/blue double-node mark is absent from user-visible brand assets;
- brand-focused tests and typecheck pass;
- unrelated worktree files remain untouched.

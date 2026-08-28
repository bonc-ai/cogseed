---
name: cogseed-component-change
description: Modify or add shared CogSeed Renderer components, their component-gallery coverage, or their integration into real business pages. Use for 调整组件、新增组件、统一组件、补充组件状态、修改共享 UI、更新组件预览页, or connecting approved components to production Renderer pages. Do not use for product-only prototypes, page-local composition with no shared-component impact, or unrelated Renderer fixes.
---

# CogSeed Component Change

Change CogSeed components without letting the product contract, production implementation, preview coverage, tests, and real-page evidence drift apart.

## Preserve the two-repository boundary

- Work from the `cogseed-source` repository for production components, the component gallery, tests, real-page integration, and Electron verification.
- Locate the independent `cogseed-product` repository and recheck its current path rather than assuming that a historical checkout is still active. The expected sibling checkout is `../cogseed-product`.
- Treat `my-work/work/cogseed-ux-consistency/CogSeed_首版组件与预览页产品清单_v0.1_Draft.md` and the work-package README in the product repository as the current product contract and routing source. Read the live files; do not copy their component rules into this Skill.
- A product document or gallery result is not implementation, QA, release, or real-page proof. Keep those evidence lanes separate.
- Inspect Git status in every repository the request may touch. Preserve pre-existing changes and do not package unrelated work.

## Classify the change before editing

Choose the smallest matching class and state it in the working update:

1. **Component contract change**: changes a shared component's role, API, states, behavior, wording rules, accessibility contract, or acceptance criteria. Update the product checklist before or together with implementation when the current request authorizes the formal component adjustment. If the request is source-only, describe the required product delta and do not present the implementation as accepted contract truth.
2. **Existing-contract correction**: fixes production code that fails an already-defined contract. Change the production component, regression coverage, and any gallery case needed to reproduce the failure. Do not churn the product checklist when its meaning is unchanged.
3. **Page-specific composition**: combines existing components for one business page without creating a reusable primitive. Keep it in that page and add integration coverage; do not extract a shared component merely to satisfy this workflow.
4. **Experiment**: explores a visual or interaction option before approval. It may live in the gallery only when clearly labeled experimental and isolated from production claims.

Promote a new shared component only when multiple pages need the same stable role or behavior. Repeated appearance alone is insufficient if the business semantics differ.

## Implement through the production seam

1. Read the current product contract, relevant production component files under `src/renderer/`, `component-gallery.*`, the target business page, and directly related tests.
2. For an authorized contract change, make the product requirement and acceptance case unambiguous before relying on implementation details to define the behavior. Keep unresolved choices Draft or blocked instead of silently deciding them in code.
3. Modify the production token, shared CSS, or classic-script component. Preserve Renderer constraints: no JSX/bundler, no new dependency without discussion, icons from `modules/icons.js`, visible strings through i18n, and no change to business data, validation, scheduling, or IPC unless the user explicitly requested it.
4. Make the gallery load the same production token, CSS, and component JS. Gallery-only CSS may arrange specimens and annotations, but must not duplicate or override the component implementation to manufacture the target appearance.
5. Add the smallest state and interaction matrix that makes the changed contract observable. Include relevant default, hover, active, focus, disabled, loading, error, empty, destructive, keyboard, narrow-layout, or recovery states; do not add irrelevant matrix cells mechanically.
6. Add tests at public component or page-integration seams. Cover the changed invariant and its failure or recovery path where applicable; avoid assertions tied only to private implementation structure.
7. Integrate into a real business page only when the target contract has been confirmed or the current request explicitly activates that integration. Reuse the shared component while preserving the page's existing data, validation, scheduling, and IPC behavior.

## Verify proportionately

- Choose the verification profile from the delivery intent; branch names alone are supporting evidence, not the decision:
  - **Reference spike / gallery experiment**: run focused component tests, `npm run typecheck`, `git diff --check`, and the relevant gallery checks. Do not run the full `npm test` by default. Treat results as reference evidence only, not merge readiness.
  - **Real-page integration under active development**: add focused page-integration tests and Electron verification to the spike checks. Run the full `npm test` only when the change crosses Renderer/Main or IPC boundaries, changes business behavior or shared runtime infrastructure, adds dependencies or packaged resources, or the user explicitly requests the full gate.
  - **Merge or release candidate**: run the repository-required complete gate, including `npm test`, before claiming merge or release readiness.
- Use the repository test runner rather than direct `npx vitest`. If a requested full-suite run fails outside the component scope, preserve and report the failure separately rather than weakening acceptance.
- Run `git diff --check` for every touched repository and review the scoped diff for duplicated gallery styles, hard-coded icons, untranslated visible strings, and accidental business-logic changes.
- Check the changed component at a desktop and a constrained width. Exercise applicable keyboard focus, Tab/Shift+Tab, Escape ordering, focus return, IME-safe shortcuts, reduced motion, and accessible names.
- After source changes are complete, follow the repository restart rule with `scripts/restart-cogseed.sh`, confirm the launcher and runtime logs, and verify the changed behavior in the real Electron environment. A browser-opened gallery alone is insufficient real-environment evidence.
- When a real business page was integrated, verify both its normal path and the changed loading, empty, error, disabled, destructive, or recovery state that the component contract affects.

## Report separate outcomes

Report these independently:

- **Product contract**: unchanged, updated Draft, confirmed, or blocked.
- **Production implementation**: complete or partial, with the component and page surfaces named.
- **Gallery acceptance**: passed, failed, or not run, with the exercised states.
- **Real-page acceptance**: passed, failed, blocked, or not applicable.
- **Verification profile**: reference spike, active real-page integration, or merge/release candidate; list only the gates actually run.
- **Delivery**: local, committed, merged, or released. Do not infer commit, push, PR, merge, or release from a component-change request.

Never use a green gallery matrix, passing static test, or updated checklist to claim that the real application page has shipped.

# Renderer rewrite migration inventory

> Human-owned matrix. Generated source counts live in `src/renderer-app/migration/inventory.generated.json`; update this matrix only after reviewing behavior ownership and rollback boundaries.

- Baseline commit: `defcd5f55aa7bd9fa2749fe80818eb9cf597a54b`
- Snapshot command: `node scripts/capture-ipc-contract.cjs --check && node scripts/capture-renderer-inventory.cjs --check`
- Current checkout note: local `develop` is 137 commits behind `origin/develop`; do not refresh this matrix against a different base without regenerating all snapshots.

## Baseline inventory

| Metric | Value |
|---|---:|
| firstPartyModules | 89 |
| vendorJavaScriptFiles | 6 |
| scriptTags | 68 |
| externalScriptTags | 65 |
| inlineScriptTags | 3 |
| cssFiles | 6 |
| loc | 79381 |
| firstPartyLoc | 77071 |
| directDomCallCount | 3451 |
| domQueryCallCount | 1993 |
| globalEventRegistrations | 173 |
| timerCount | 140 |
| observerCount | 7 |
| directIpcCallCount | 427 |

## Ownership and migration rules

1. A feature has exactly one DOM/event/timer/observer/IPC owner at runtime.
2. A React owner must expose mount/dispose and release listeners, timers, observers, streams, and third-party instances on rollback.
3. `window.cogseed.invoke` and `window.cogseed.stream` are legacy-only until a named adapter is reviewed; React source may not call the bridge directly.
4. Vendor files remain unchanged and are loaded by the legacy entry until an explicit replacement is verified.
5. `status` is intentionally human-maintained; changing it requires the corresponding characterization, component, and Golden Path evidence.

## First-party module matrix

| Legacy module | Baseline LOC | IPC calls | DOM/query calls | Target owner | Phase | Status |
|---|---:|---:|---:|---|---|---|
| `src/renderer/modules/account-chip.js` | 487 | 1 | 14 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/agents.js` | 5060 | 42 | 202 | `agents` | Phase 2 | `legacy` |
| `src/renderer/modules/artifact-security.js` | 39 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/auto-events.js` | 55 | 1 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/auto-title.js` | 74 | 0 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/auto.js` | 2278 | 18 | 75 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/avatar-picker.js` | 165 | 0 | 6 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/avatar.js` | 156 | 1 | 0 | `shared/ui` | Phase 0示范 | `legacy` |
| `src/renderer/modules/bash_permission.js` | 329 | 3 | 8 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/boot.js` | 590 | 0 | 15 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/bridge.js` | 62 | 1 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/briefing-center.js` | 21 | 0 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/chat-artifact.js` | 456 | 1 | 5 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-aside.js` | 267 | 3 | 1 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-file-viewer.js` | 958 | 7 | 12 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-input-form.js` | 709 | 2 | 3 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-lightbox.js` | 379 | 2 | 7 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-md-drawer.js` | 169 | 1 | 7 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-side-browser.js` | 182 | 1 | 3 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-side-host.js` | 165 | 0 | 1 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/chat-use.js` | 799 | 1 | 9 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/cognition/cognition.js` | 632 | 0 | 29 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/cognition/pages.js` | 428 | 0 | 0 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/companion-repro.js` | 205 | 8 | 5 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/connections.js` | 149 | 0 | 6 | `connectors/observability` | Phase 2 | `legacy` |
| `src/renderer/modules/connectors.js` | 1171 | 9 | 26 | `connectors/observability` | Phase 2 | `legacy` |
| `src/renderer/modules/context-menu.js` | 136 | 0 | 2 | `shared/ui` | Phase 0示范 | `legacy` |
| `src/renderer/modules/contexts.js` | 1850 | 1 | 69 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/continue-work.js` | 785 | 12 | 37 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/conv-bucket.js` | 32 | 0 | 0 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/conversation-info.js` | 2564 | 8 | 14 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/conversation.js` | 16183 | 48 | 406 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/delete-file-confirm.js` | 347 | 2 | 11 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/dialogs.js` | 276 | 0 | 9 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/execution-card.js` | 189 | 0 | 9 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/expense-agent-cards.js` | 259 | 1 | 1 | `expense` | Phase 2 | `legacy` |
| `src/renderer/modules/expense-workbench.js` | 85 | 1 | 5 | `expense` | Phase 2 | `legacy` |
| `src/renderer/modules/file-operation-policy.js` | 48 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/hub-account.js` | 389 | 1 | 11 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/i18n.js` | 196 | 0 | 3 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/icons.js` | 245 | 0 | 1 | `shared/ui` | Phase 0示范 | `legacy` |
| `src/renderer/modules/import-check-modal.js` | 199 | 0 | 1 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/interactive-cli.js` | 328 | 3 | 18 | `agents` | Phase 2 | `legacy` |
| `src/renderer/modules/interactive-tour.js` | 565 | 2 | 22 | `onboarding` | Phase 2 | `legacy` |
| `src/renderer/modules/ipc-shim.js` | 444 | 4 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/kb-picker.js` | 307 | 0 | 12 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/lazy-features.js` | 104 | 0 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/library-transfer.js` | 265 | 0 | 10 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/local-agents.js` | 348 | 5 | 2 | `agents` | Phase 2 | `legacy` |
| `src/renderer/modules/logger.js` | 131 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/marketplace.js` | 2299 | 18 | 53 | `marketplace` | Phase 2 | `legacy` |
| `src/renderer/modules/math.js` | 122 | 0 | 1 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/md-view-edit.js` | 793 | 2 | 16 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/memory.js` | 1180 | 2 | 42 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/messaging-settings.js` | 1967 | 1 | 7 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/model-authorization.js` | 1142 | 1 | 1 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/model-chip.js` | 437 | 7 | 15 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/model-guard.js` | 207 | 3 | 4 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/name-limit.js` | 111 | 0 | 0 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/onboarding.js` | 3105 | 45 | 148 | `onboarding` | Phase 2 | `legacy` |
| `src/renderer/modules/oss.js` | 463 | 6 | 6 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/p3394-observability.js` | 44 | 0 | 0 | `connectors/observability` | Phase 2 | `legacy` |
| `src/renderer/modules/personal-context-center-view.js` | 176 | 0 | 0 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/personal-context-center.js` | 188 | 1 | 1 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/personal-context-review.js` | 25 | 0 | 0 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/personal-ontology.js` | 1090 | 2 | 26 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/pinyin-firstletter.js` | 54 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/plan-rail.js` | 267 | 0 | 1 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/queue-draft.js` | 425 | 0 | 15 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/recall-information-architecture.js` | 31 | 0 | 0 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/recall-projection-card.js` | 175 | 5 | 0 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/search.js` | 442 | 0 | 23 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/settings-security.js` | 370 | 5 | 6 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/settings.js` | 3355 | 61 | 185 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/settings_tabs.js` | 39 | 0 | 4 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/sidebar-resize.js` | 127 | 0 | 4 | `shared/ui` | Phase 0示范 | `legacy` |
| `src/renderer/modules/skills-bindings.js` | 1663 | 27 | 48 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/skills.js` | 7812 | 39 | 163 | `cognition` | Phase 2 | `legacy` |
| `src/renderer/modules/state.js` | 455 | 0 | 29 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/strip-structural-blocks.js` | 661 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/terminal-panel.js` | 460 | 5 | 10 | `conversation` | Phase 1 | `legacy` |
| `src/renderer/modules/text-view-edit.js` | 266 | 2 | 5 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/touchpoint-settings-model.js` | 67 | 0 | 0 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/touchpoint-settings.js` | 421 | 1 | 6 | `settings` | Phase 2 | `legacy` |
| `src/renderer/modules/user-error.js` | 76 | 0 | 0 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/user-workspace.js` | 335 | 2 | 10 | `shared/feature` | Phase 2/共享 | `legacy` |
| `src/renderer/modules/utils.js` | 1899 | 1 | 10 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/validation-report-view.js` | 226 | 0 | 2 | `shared/helpers` | Phase 0/共享 | `legacy` |
| `src/renderer/modules/workspace.js` | 1836 | 1 | 75 | `shared/feature` | Phase 2/共享 | `legacy` |

## Vendor and entry assets

| Asset | Role | Migration policy |
|---|---|---|
| `src/renderer/vendor/dompurify/purify.min.js` | vendor JavaScript (3 LOC) | preserve unchanged until replacement gate |
| `src/renderer/vendor/mathjax/tex-chtml.js` | vendor JavaScript (0 LOC) | preserve unchanged until replacement gate |
| `src/renderer/vendor/pinyin-firstletter/data.js` | vendor JavaScript (8 LOC) | preserve unchanged until replacement gate |
| `src/renderer/vendor/qrcode-generator/qrcode.js` | vendor JavaScript (2297 LOC) | preserve unchanged until replacement gate |
| `src/renderer/vendor/xterm/addon-fit.js` | vendor JavaScript (1 LOC) | preserve unchanged until replacement gate |
| `src/renderer/vendor/xterm/xterm.js` | vendor JavaScript (1 LOC) | preserve unchanged until replacement gate |
| `src/renderer/execution-card.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |
| `src/renderer/onboarding.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |
| `src/renderer/recall-local.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |
| `src/renderer/style.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |
| `src/renderer/vendor/xterm/xterm.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |
| `src/renderer/workspace.css` | renderer stylesheet | preserve during staged migration; namespace new React CSS |

## Evidence required to change a row

- Characterization fixture records current behavior before the row changes from `legacy`.
- New owner has focused tests for state, IPC error/timeout, and cleanup.
- Feature flag can switch to legacy without reloading or changing the IPC contract.
- Golden Path and platform smoke checks pass for the affected surface.
- Row status is changed in the same review as the feature migration commit.

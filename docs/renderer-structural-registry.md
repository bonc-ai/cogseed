# Renderer structural registry

Page-local structural components that are **not** (yet) part of the shared Renderer API.
`AGENTS.md` → `## Renderer` defines the three states (Shared / Provisional composition / Prohibited);
this file is the registry those states refer to.

Owner: **@bonc-ai/reviewers**. Rules:

- **Register before landing.** A new page-local structural component needs an entry here (new ID) in the same PR that introduces it. Unregistered page-local structure is treated as Prohibited.
- **Mark `Migrated`, never delete.** When a shared seam takes over a structure, flip its status to `Migrated` and note the seam. Removing the row would erase the history that the entry records.
- **Two pages ⇒ propose.** Per `AGENTS.md`, once two pages need the same stable contract, the structure must be proposed for the shared layer instead of extended page-locally.
- Provisional entries still owe tokens, native semantics, accessible keyboard behavior, and must not introduce a second visual/behavioral variant.

## Provisional composition (approved)

| ID | Surface | Owner file | Status | Why page-local |
| --- | --- | --- | --- | --- |
| PV-1 | Context menu (`kb-ctx-menu-*`) | `src/renderer/modules/kb-workbench.js` | Provisional | No generic menu seam exists (only the user-menu APIs). Propose `uiMenu` when a second page needs it. |
| PV-2 | Workbench layout shell (`kb-wb-*`: side rail, toolbar, split panes) | `src/renderer/modules/kb-workbench.js` | Provisional | Business layout. Its tab strip is tracked separately (`M-6`, migrated to `uiTabs`/`hydrateUiTabs`). |
| PV-3 | File-reader **internals** (zoom, page navigation, block marks, **and drag / resize**) | `src/renderer/modules/kb-workbench.js` | Provisional | Drag and resize have no shared seam; they stay owned by the reader's business layer. The overlay/dialog shell is tracked separately (`M-2`, migrated to `uiModalController`). |
| PV-4 | Media-manager **internals** (thumbnail grid, multi-select, batch actions) | `src/renderer/modules/kb-workbench.js` | Provisional | Same reasoning as PV-3. Its overlay shell is tracked separately (`M-3`). |

## Business content (not registered)

These are business content, not structural components, so they are intentionally absent from the table above.
They still owe tokens, native semantics, accessible keyboard behavior, and shared primitives **for any generic control inside them**.

| Surface | Owner file | Note |
| --- | --- | --- |
| Q&A conversation stream (`kb-qa-*`) | `src/renderer/modules/kb-workbench.js` | Conversation stream is business content. Generic controls inside it keep going through the shared layer. |
| Attachment entries (`kb-note-attach`, `kb-qa-attach*`) | `src/renderer/modules/kb-notes.js`, `kb-workbench.js` | **Not a `uiChip`.** `uiChip` carries interactive-filter semantics; an attachment entry is content. Keep the business presentation. |
| Business keyboard shortcuts | `src/renderer/modules/kb-*.js` | Only **shared interaction** keyboard semantics migrate (Tabs / Tree / Accordion / Modal / Drawer). Business shortcuts stay page-owned; text inputs still honor `e.isComposing \|\| e.keyCode === 229`. |

## Migration backlog

Structures whose shared seam already exists. `Pending` → `Migrated` as each lands; the shared
adoption baselines in `test/renderer/shared-ui-adoption-guard.test.ts` must be lowered in the same PR.

| ID | Surface | Shared seam | Status |
| --- | --- | --- | --- |
| M-1 | Share / create-shared-library dialog shell (`kb-share-*`) | `uiModalController(...)` | Pending |
| M-2 | File-reader overlay/dialog shell (`kb-fv-overlay`, `kb-fv-dialog`) | `uiModalController(...)` | Pending |
| M-3 | Media-manager overlay shell (`kb-mm-overlay*`) | `uiModalController(...)` | Pending |
| M-4 | Import dialog (`kb-import-dlg*`) | `uiModal(...)` / `uiModalController(...)` | Pending |
| M-5 | Directory tree (`kb-tree-*`) | `uiTree(...)` + `hydrateUiTrees(...)` | Pending |
| M-6 | Workbench tab strip | `uiTabs(...)` + `hydrateUiTabs(...)` | Pending |
| M-7 | Quiz source overlay (`kb-qz-overlay`) | `uiModal(...)` | Pending |
| M-8 | Picker modal (`kb-picker-modal`) | `uiModal(...)` / `uiChoice(...)` | Pending |
| M-9 | Page-local card / tag / badge / status / progress / skeleton classes | `uiCard` / `uiTag` / `uiBadge` / `uiStatusPill` / `uiProgressBar` / `uiSkeleton` | Pending |
| M-10 | Literal `z-index` in KB modules | `--z-*` tokens | **Migrated** (kb-workbench reader overlay/handle/drag shield → `--z-modal` / `--z-raised` / `--z-sticky`) |
| M-11 | Emoji used as icons in KB modules | `modules/icons.js` | **Migrated** (kb-notes / kb-quiz / kb-workbench → `uiIconHtml`) |

## Known non-icon inline SVG

Business graphics render `<svg>` legitimately and stay page-owned (the shared adoption guard counts
inline `<svg>`, so these are recorded here to keep the counter honest):

| Surface | Owner file | Note |
| --- | --- | --- |
| Mind-map canvas (`kb-mm-svg`) | `src/renderer/modules/kb-workbench.js` | Canvas rendering, not an icon. |
| Library cover artwork (`kb-wb-cover-svg`) | `src/renderer/modules/kb-workbench.js` | Decorative artwork, not an icon. |
| Duplicate icon table `_SVGS` + `_svg()` | `src/renderer/modules/kb-workbench.js` | **Violation, being removed** — a second icon registry with hand-written paths; must delegate to `modules/icons.js`. |

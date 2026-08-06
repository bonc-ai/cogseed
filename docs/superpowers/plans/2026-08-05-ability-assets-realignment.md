# Ability Assets Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Realign the cognition center so Candidates represent cognition candidates and Assets represent formal/user-owned ability assets, not marketplace skills.

**Architecture:** Keep existing cognition IPC channels, but change the normalized asset model to PRD ability-asset categories. Skills remain in the Skills tab. The Assets renderer becomes an Ability Assets workbench with internal List / Tree / Usage views.

**Tech Stack:** Electron main TypeScript, classic renderer JavaScript/HTML/CSS, Vitest via `npm run test:js`, `npm run typecheck`.

---

## Task 1: Lock backend ability-asset semantics

**Files:**
- Modify `test/main/features/cognition.test.ts`
- Modify `src/main/features/cognition/types.ts`
- Modify `src/main/features/cognition/assets-adapter.ts`

Steps:
- [ ] Update tests so `listCognitionAssets` does not expose memory or marketplace skills as ability assets.
- [ ] Require asset categories `personal`, `rule`, `template`, `skill_method`, maturity, owner/scope, workspace/receipt/candidate refs.
- [ ] Implement list normalization from personal ontology groups and p3394 candidates.
- [ ] Run `npm run test:js -- test/main/features/cognition.test.ts`.

## Task 2: Lock renderer page semantics

**Files:**
- Modify `test/renderer/skills-cognition-layout.test.ts`
- Modify `test/renderer/skills-frontmatter.test.ts`
- Modify `src/renderer/index.html`
- Modify `src/renderer/modules/skills.js`
- Modify `src/renderer/style.css`
- Modify renderer locales

Steps:
- [ ] Test top tab labels include Cognition Candidates and Ability Assets semantics.
- [ ] Test Assets tab renders internal Asset List / Cognition Tree / Usage Records views.
- [ ] Test assets render PRD categories and do not render marketplace skill rows as assets.
- [ ] Implement the Ability Assets renderer.
- [ ] Run `npm run test:js -- test/renderer/skills-cognition-layout.test.ts test/renderer/skills-frontmatter.test.ts`.

## Task 3: Focused verification

Steps:
- [ ] Run `git diff --check`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run test:js -- test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/renderer/skills-cognition-layout.test.ts test/renderer/skills-frontmatter.test.ts`.

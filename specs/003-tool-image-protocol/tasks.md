# Tasks: Tool Image Protocol Repair

## Phase 1: Reproduction and Contract

- [X] T001 Read CogSeed attachment and inspect session, runner, and provider conversion paths
- [X] T002 Add failing mixed image/text tool ordering tests in `src/core-agent/test/parallel-tools.test.ts`

## Phase 2: Implementation

- [X] T003 Add image-only session append support in `src/core-agent/src/agent/session.ts`
- [X] T004 Defer and flush tool images at the assistant tool-turn boundary in `src/core-agent/src/agent/runner.ts`

## Phase 3: Validation

- [X] T005 Run focused core-agent regression tests
- [X] T006 Run TypeScript typecheck
- [X] T007 Review diff against COGSEED-341 acceptance requirements

# Mate Agent Native Kernel Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add Native Kernel Prompt / Context Assembler so Runtime prompts are explicit-only, transcript-safe, path-redacted, and independent from core-agent/group-chat prompt construction.

**Architecture:** Build two pure/defensive layers under `src/main/features/cogseed_runtime/kernel/`: `prompt-assembler.ts` formats a small stable system/user prompt from already-assembled context, while `context/assembler.ts` validates explicit context/attachments, pre-reads only sandboxed text files, assigns opaque file refs, and never exposes raw transcript/session paths. Production execution remains on `core-executor.ts`; this phase only creates native assembler components and tests.

**Tech Stack:** Electron main TypeScript, existing `RuntimeKernelRequest` types, existing `path-sandbox.ts`, existing Runtime protocol transcript guard, Node `fs/promises`, Vitest via `npm run test:js`.

---

## File Structure

- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/prompt-assembler.ts`
  - Pure prompt formatter. No file IO, no model/client import, no group-chat import.
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/context/assembler.ts`
  - Explicit context/attachment assembler. Performs file IO only for sandboxed text previews. Emits opaque file refs.
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/protocol.ts`
  - Export the transcript-path predicate for kernel defensive reuse without changing protocol behavior.
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/prompt-assembler.test.ts`
  - Prompt fixtures: empty context, text context, file refs, memory summary, transcript/path redaction.
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/context-assembler.test.ts`
  - Context assembler fixtures: explicit text, file preview, max-char truncation, sandbox denial, transcript denial, symlink denial, opaque refs.
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/import-boundary.test.ts`
  - Existing recursive scan should automatically cover new files; add an assertion if needed for prompt/context modules.

---

### Task 1: Prompt Assembler Pure Layer

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/prompt-assembler.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/prompt-assembler.test.ts`

- [ ] **Step 1: Write the failing tests**

Create tests covering:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';
import { assembleRuntimePrompt, buildRuntimeSystemPrompt } from '../../../../../src/main/features/cogseed_runtime/kernel/prompt-assembler';
import type { RuntimeKernelRequest } from '../../../../../src/main/features/cogseed_runtime/kernel/types';

function request(overrides: Partial<RuntimeKernelRequest> = {}): RuntimeKernelRequest {
  return {
    userId: 'u1',
    requestId: 'req-prompt',
    runtimeSessionId: 'mruntime-prompt',
    task: 'Summarize the explicit material.',
    context: [],
    attachments: [],
    readOnlyRoots: [],
    writableRoots: [],
    toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    ...overrides,
  };
}

describe('native Runtime prompt assembler', () => {
  it('builds a short stable system prompt with explicit-only rules', () => {
    expect(buildRuntimeSystemPrompt()).toContain('Mate Agent Runtime worker');
    expect(buildRuntimeSystemPrompt()).toContain('explicit task, context, and attachments');
    expect(buildRuntimeSystemPrompt()).not.toContain('/Users/');
  });

  it('formats an empty-context request without inventing history', () => {
    const prompt = assembleRuntimePrompt({ request: request() });
    expect(prompt.system).toContain('Mate Agent Runtime worker');
    expect(prompt.user).toContain('## Task');
    expect(prompt.user).toContain('Summarize the explicit material.');
    expect(prompt.user).toContain('No explicit context was provided.');
    expect(prompt.user).not.toContain('gconv');
    expect(prompt.user).not.toContain('group_chat');
  });

  it('includes explicit text context and opaque file references', () => {
    const prompt = assembleRuntimePrompt({
      request: request(),
      context: {
        textSections: [{ id: 'ctx-1', label: 'note', text: 'Alpha' }],
        fileRefs: [{ id: 'file-1', label: 'draft.md', kind: 'context_file', preview: 'Preview text' }],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 0, truncated: false },
      },
    });
    expect(prompt.user).toContain('Alpha');
    expect(prompt.user).toContain('file-1');
    expect(prompt.user).toContain('Preview text');
    expect(prompt.user).not.toContain('/tmp/draft.md');
  });

  it('redacts transcript-shaped path hints from task/context text', () => {
    const prompt = assembleRuntimePrompt({
      request: request({ task: 'Read cloud/chats/gconv-secret.jsonl and local/cogseed_runtime/sessions/mruntime-secret.jsonl' }),
      context: {
        textSections: [{ id: 'ctx-1', text: 'Also see cloud/sessions/gmember-secret.jsonl' }],
        fileRefs: [],
        diagnostics: { inputContextCount: 1, inputAttachmentCount: 0, truncated: false },
      },
    });
    expect(prompt.user).toContain('[redacted-transcript-path]');
    expect(prompt.user).not.toContain('gconv-secret.jsonl');
    expect(prompt.user).not.toContain('gmember-secret.jsonl');
    expect(prompt.user).not.toContain('mruntime-secret.jsonl');
  });

  it('reports diagnostics without raw content', () => {
    const prompt = assembleRuntimePrompt({ request: request() });
    expect(prompt.diagnostics).toEqual(expect.objectContaining({ textChars: expect.any(Number), fileRefCount: 0 }));
    expect(JSON.stringify(prompt.diagnostics)).not.toContain('Summarize the explicit material.');
  });
});
```

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/prompt-assembler.test.ts --maxWorkers=1
```

Expected: FAIL with module-not-found.

- [ ] **Step 2: Implement `prompt-assembler.ts`**

Create these exports:

```ts
export interface RuntimePromptTextSection {
  id: string;
  label?: string;
  text: string;
}

export interface RuntimePromptFileRef {
  id: string;
  label: string;
  kind: 'context_file' | 'attachment';
  preview?: string;
}

export interface AssembledRuntimeContext {
  textSections: RuntimePromptTextSection[];
  fileRefs: RuntimePromptFileRef[];
  diagnostics: {
    inputContextCount: number;
    inputAttachmentCount: number;
    truncated: boolean;
  };
}

export interface RuntimePromptAssemblyResult {
  system: string;
  user: string;
  diagnostics: {
    textChars: number;
    fileRefCount: number;
    truncated: boolean;
  };
}

export function buildRuntimeSystemPrompt(): string;
export function redactTranscriptPathHints(text: string): string;
export function assembleRuntimePrompt(input: { request: RuntimeKernelRequest; context?: AssembledRuntimeContext; memorySummary?: string }): RuntimePromptAssemblyResult;
```

Implementation rules:

- Do not import `#core-agent`, `model/client`, or `features/group_chat`.
- Do not include absolute file paths in prompt output.
- Include only task, explicit text sections, opaque file refs/previews, optional memory summary.
- Redact transcript-like strings matching cloud/local chats/sessions/cogseed_runtime JSONL path hints.
- Diagnostics must contain counts/lengths only, no raw prompt text.

- [ ] **Step 3: Verify Task 1**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/prompt-assembler.test.ts --maxWorkers=1
npm run typecheck -- --pretty false
```

Expected: PASS.

### Task 2: Context Assembler Explicit File/Text Layer

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/protocol.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/cogseed_runtime/kernel/context/assembler.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/context-assembler.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests covering:

- explicit text context becomes a `textSections` entry.
- explicit text file context inside allowed root is pre-read into a preview.
- file refs use opaque ids and labels, not absolute paths.
- max prompt context chars truncates previews and marks diagnostics truncated.
- file outside `readOnlyRoots` is rejected.
- transcript/session JSONL path is rejected even when under `readOnlyRoots`.
- symlink alias to transcript is rejected.
- sandboxed non-JSONL project file remains allowed.

Expected command:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/context-assembler.test.ts --maxWorkers=1
```

Initial result: FAIL with module-not-found.

- [ ] **Step 2: Export transcript predicate from protocol**

In `protocol.ts`, export a stable defensive helper:

```ts
export function isRuntimeTranscriptPath(uid: string, candidate: string): boolean {
  return isTranscriptPath(uid, candidate);
}
```

Do not weaken existing transcript tests.

- [ ] **Step 3: Implement `kernel/context/assembler.ts`**

Create exports:

```ts
export interface RuntimeContextAssemblerOptions {
  maxPromptContextChars?: number;
}

export async function assembleRuntimeContext(
  request: RuntimeKernelRequest,
  options?: RuntimeContextAssemblerOptions,
): Promise<AssembledRuntimeContext>;
```

Implementation rules:

- Use `request.context` and `request.attachments` only.
- For `text` context: add redacted text section.
- For `file` context and file attachments:
  - path must be absolute.
  - path must be allowed by `isPathAllowed(path, request.readOnlyRoots)`.
  - path must not be `isRuntimeTranscriptPath(request.userId, path)`.
  - text preview only for text-like extensions: `.txt`, `.md`, `.markdown`, `.json`, `.csv`, `.log`, `.yaml`, `.yml`, `.xml`.
  - `.jsonl` should not be pre-read in Phase 2.
  - emit opaque ids like `file-1`; never include absolute path in returned prompt-facing labels/previews.
- Enforce `DEFAULT_RUNTIME_KERNEL_CONFIG.maxPromptContextChars` default.
- If over limit, truncate previews/text and set diagnostics.truncated.

- [ ] **Step 4: Verify Task 2**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/context-assembler.test.ts --maxWorkers=1
npm run test:js -- test/main/features/cogseed_runtime/protocol.test.ts test/main/features/cogseed_runtime/kernel/context-assembler.test.ts --maxWorkers=1
npm run typecheck -- --pretty false
```

Expected: PASS.

### Task 3: Prompt + Context Integration Fixtures and Boundary

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/import-boundary.test.ts`
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/cogseed_runtime/kernel/prompt-context-integration.test.ts`

- [ ] **Step 1: Write integration tests**

Create a test that:

- Builds a `RuntimeKernelRequest` with text context + file context.
- Calls `assembleRuntimeContext(...)`.
- Calls `assembleRuntimePrompt(...)`.
- Asserts final prompt includes task/text/file preview.
- Asserts final prompt does not include absolute paths, `cid`, `gconv`, `cloud/chats`, `cloud/sessions`, or `local/cogseed_runtime/sessions`.

Also ensure import-boundary test still scans new `kernel/context/*.ts` files and catches relative `group_chat` imports.

- [ ] **Step 2: Run integration tests**

Run:

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel/prompt-context-integration.test.ts test/main/features/cogseed_runtime/kernel/import-boundary.test.ts --maxWorkers=1
```

Expected: PASS after any minimal test/boundary adjustments.

### Task 4: Phase 2 Verification

**Files:**
- No source changes unless tests reveal defects.

- [ ] **Step 1: Run Phase 2 kernel tests**

```bash
npm run test:js -- test/main/features/cogseed_runtime/kernel --maxWorkers=1
```

Expected: all kernel tests pass.

- [ ] **Step 2: Run full Runtime tests**

```bash
npm run test:js -- test/main/features/cogseed_runtime --maxWorkers=1
```

Expected: all Runtime tests pass.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck -- --pretty false
```

Expected: PASS.

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: full JS/resource suites pass, or record exact unrelated local failures.

---

## Verification

Before claiming Phase 2 complete, run:

```bash
npm run test:js -- test/main/features/cogseed_runtime --maxWorkers=1
npm run typecheck -- --pretty false
npm test
```

## Next skill

`$superpower-subagents` is required for implementation in this session because the user selected Subagent-Driven execution.

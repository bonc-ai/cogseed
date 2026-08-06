import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/mate_agent_runtime/kernel/config';
import { createRuntimeSessionRunner } from '../../../../../src/main/features/mate_agent_runtime/kernel/session-runner';
import {
  appendRuntimeMemoryEntry,
  readRuntimeMemory,
  runtimeMemoryFile,
} from '../../../../../src/main/features/mate_agent_runtime/kernel/memory/store';
import { loadRuntimeMemorySummary } from '../../../../../src/main/features/mate_agent_runtime/kernel/memory/injector';
import { buildRuntimeMemoryEntryFromResult } from '../../../../../src/main/features/mate_agent_runtime/kernel/memory/extractor';
import {
  importRuntimeContextFile,
  runtimeContextImportFile,
} from '../../../../../src/main/features/mate_agent_runtime/kernel/context/store';
import { assembleRuntimeContextForPrompt } from '../../../../../src/main/features/mate_agent_runtime/kernel/context/importer';
import type { RuntimeModelAdapter, RuntimeModelRequest } from '../../../../../src/main/features/mate_agent_runtime/kernel/model-adapter';
import type { RuntimeToolResult } from '../../../../../src/main/features/mate_agent_runtime/kernel/tools/file-tools';
import type { RuntimeKernelEvent, RuntimeKernelRequest } from '../../../../../src/main/features/mate_agent_runtime/kernel/types';

const UID = 'runtime-memory-context-user';
const SESSION = 'mruntime-memory-context';

function request(overrides: Partial<RuntimeKernelRequest> = {}): RuntimeKernelRequest {
  return {
    userId: UID,
    requestId: 'req-memory-context',
    runtimeSessionId: SESSION,
    task: 'Use explicit inputs only.',
    context: [],
    attachments: [],
    readOnlyRoots: [],
    writableRoots: [],
    toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<RuntimeKernelEvent>): Promise<RuntimeKernelEvent[]> {
  const out: RuntimeKernelEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function oneShotAdapter(): RuntimeModelAdapter & { seen: RuntimeModelRequest[] } {
  const seen: RuntimeModelRequest[] = [];
  return {
    seen,
    async *stream(input: RuntimeModelRequest) {
      seen.push(input);
      yield { type: 'delta', text: 'done' };
      yield { type: 'done' };
    },
  };
}

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('Mate Agent Runtime memory and context', () => {
  it('stores runtime memory only under the local mate_runtime root and defaults to empty', async () => {
    expect(await readRuntimeMemory(UID)).toBe('');

    await appendRuntimeMemoryEntry(UID, 'Prefer concise answers.');

    expect(runtimeMemoryFile(UID)).toBe(path.join(paths.mateRuntimeMemoryDir(UID), 'runtime.md'));
    expect(await readRuntimeMemory(UID)).toContain('Prefer concise answers.');
    expect(fs.existsSync(path.join(paths.userCloudRoot(UID), 'memory', 'MEMORY.md'))).toBe(false);
  });

  it('injects only Runtime local memory and ignores Mate Agent cloud memory', async () => {
    const cloudMemory = path.join(paths.userCloudRoot(UID), 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(cloudMemory), { recursive: true });
    fs.writeFileSync(cloudMemory, 'Cloud-only Mate Agent memory must stay out.');
    await appendRuntimeMemoryEntry(UID, 'Runtime-local memory should appear.');

    const summary = await loadRuntimeMemorySummary(UID);

    expect(summary).toContain('Runtime-local memory should appear.');
    expect(summary).not.toContain('Cloud-only Mate Agent memory must stay out.');
  });

  it('preloads only explicitly supplied context files into the prompt budget', async () => {
    const root = path.join(paths.userLocalRoot(UID), 'explicit-context-root');
    const explicit = path.join(root, 'included.txt');
    const sibling = path.join(root, 'not-mentioned.txt');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(explicit, 'Explicit file content alpha.');
    fs.writeFileSync(sibling, 'Sibling content should not be scanned.');

    const assembled = await assembleRuntimeContextForPrompt(request({
      context: [{ type: 'file', path: explicit, label: 'included' }],
      readOnlyRoots: [explicit],
    }), { maxPromptContextChars: 200 });

    expect(assembled.fileRefs[0].preview).toContain('Explicit file content alpha.');
    expect(JSON.stringify(assembled)).not.toContain('Sibling content should not be scanned.');
  });

  it('imports explicit context files into local runtime contexts and refuses transcript paths', async () => {
    const root = path.join(paths.userLocalRoot(UID), 'import-root');
    const source = path.join(root, 'notes.txt');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(source, 'context notes');

    const imported = await importRuntimeContextFile(UID, source, {
      allowedRoots: [root],
      contextId: 'ctx-explicit',
    });

    expect(imported.path).toBe(runtimeContextImportFile(UID, 'ctx-explicit', 'notes.txt'));
    expect(imported.path.startsWith(paths.mateRuntimeContextsDir(UID))).toBe(true);
    expect(fs.readFileSync(imported.path, 'utf8')).toBe('context notes');

    const transcript = paths.groupChatVisibilityFile(UID, 'gconv-secret', 'agent-a');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"role":"user","content":"secret"}\n');

    await expect(importRuntimeContextFile(UID, transcript, {
      allowedRoots: [paths.userRoot(UID)],
      contextId: 'ctx-bad',
    })).rejects.toThrow(/transcript/i);
  });

  it('sanitizes successful-result memory entries without raw transcript paths or credential-like lines', () => {
    const entry = buildRuntimeMemoryEntryFromResult({
      requestId: 'req-memory-context',
      runtimeSessionId: SESSION,
      task: 'Summarize cloud/chats/gconv-secret.jsonl',
      finalText: 'Use concise tone. token=sk-secret should not persist. See local/sessions/anon-secret.jsonl',
      createdAt: '2026-08-04T00:00:00',
    });

    expect(entry).toContain('Use concise tone.');
    expect(entry).toContain('[redacted-transcript-path]');
    expect(entry).not.toContain('gconv-secret.jsonl');
    expect(entry).not.toContain('anon-secret.jsonl');
    expect(entry).not.toContain('sk-secret');
  });

  it('feeds runtime memory and explicit file previews into the native session runner prompt', async () => {
    const root = path.join(paths.userLocalRoot(UID), 'runner-root');
    const explicit = path.join(root, 'brief.txt');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(explicit, 'Runner explicit file preview.');
    await appendRuntimeMemoryEntry(UID, 'Runner memory preference.');

    const model = oneShotAdapter();
    const runner = createRuntimeSessionRunner({
      modelAdapter: model,
      toolRunner: { catalog: [], async run(): Promise<RuntimeToolResult> { return { content: 'unused' }; } },
      maxToolRounds: 1,
    });

    const events = await collect(runner.run(request({
      context: [{ type: 'file', path: explicit, label: 'brief' }],
      readOnlyRoots: [explicit],
    })));

    expect(events.at(-1)?.type).toBe('result');
    expect(model.seen[0].message).toContain('Runner memory preference.');
    expect(model.seen[0].message).toContain('Runner explicit file preview.');
  });
});

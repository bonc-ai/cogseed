import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createCogSeedAgentKernel } from '../../../../../src/main/features/cogseed_runtime/kernel';
import { createNativeRuntimeSession, appendNativeSessionRecord } from '../../../../../src/main/features/cogseed_runtime/kernel/session-store';
import * as paths from '../../../../../src/main/paths';
import type { RuntimeModelAdapter } from '../../../../../src/main/features/cogseed_runtime/kernel/model-adapter';
import type { RuntimeToolResult } from '../../../../../src/main/features/cogseed_runtime/kernel/tools/file-tools';
import { DEFAULT_RUNTIME_TOOL_POLICY } from '../../../../../src/main/features/cogseed_runtime/kernel/config';

const kernelRoot = path.join(process.cwd(), 'src/main/features/cogseed_runtime/kernel');
const UID = 'native-kernel-boundary-user';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isBannedKernelImport(specifier: string): boolean {
  return specifier.includes('group_chat')
    || specifier.includes('#core-agent')
    || specifier.includes('model/client')
    || specifier.includes('model/core-agent');
}

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('native Runtime kernel import boundary', () => {
  it('exposes a single factory entrypoint', () => {
    const kernel = createCogSeedAgentKernel();
    expect(typeof kernel.run).toBe('function');
    expect(typeof kernel.cancel).toBe('function');
    expect(typeof kernel.getSession).toBe('function');
  });

  it('returns a stable not-ready event for Phase 1 run calls', async () => {
    const kernel = createCogSeedAgentKernel();
    const events = [];
    for await (const event of kernel.run({
      userId: UID,
      requestId: 'req-boundary',
      runtimeSessionId: 'mruntime-boundary',
      task: 'Do not actually run yet',
      context: [],
      attachments: [],
      readOnlyRoots: [],
      writableRoots: [],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    })) {
      events.push(event);
    }

    expect(events).toEqual([{
      type: 'error',
      requestId: 'req-boundary',
      runtimeSessionId: 'mruntime-boundary',
      error: 'native kernel execution loop is not implemented in Phase 1',
      metadata: { code: 'native_kernel_not_ready' },
    }]);
  });



  it('delegates run calls to the native session runner when model and tool deps are injected', async () => {
    const modelAdapter: RuntimeModelAdapter = {
      async *stream() {
        yield { type: 'delta', text: 'native ok' };
        yield { type: 'done' };
      },
    };
    const kernel = createCogSeedAgentKernel({
      modelAdapter,
      toolRunner: { catalog: [], async run(): Promise<RuntimeToolResult> { return { content: 'unused' }; } },
    });

    const events = [];
    for await (const event of kernel.run({
      userId: UID,
      requestId: 'req-factory',
      runtimeSessionId: 'mruntime-factory',
      task: 'Run natively.',
      context: [],
      attachments: [],
      readOnlyRoots: [],
      writableRoots: [],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['started', 'model_delta', 'result']);
    expect(events.at(-1)?.text).toBe('native ok');
  });

  it('summarizes native runtime sessions through the factory', async () => {
    await createNativeRuntimeSession(UID, 'mruntime-summary', '2026-08-04T00:00:00');
    await appendNativeSessionRecord(UID, 'mruntime-summary', {
      type: 'turn',
      request_id: 'req-summary',
      role: 'assistant',
      content: 'done',
      created_at: '2026-08-04T00:00:01',
    });

    await expect(createCogSeedAgentKernel().getSession(UID, 'mruntime-summary')).resolves.toEqual({
      runtimeSessionId: 'mruntime-summary',
      version: 1,
      kernel: 'cogseed-agent-native',
      recordCount: 2,
      lastRequestId: 'req-summary',
    });
  });

  it('detects relative and package kernel import boundary violations', () => {
    const source = `
      import { enqueue } from '../../group_chat/bus';
      import('#core-agent');
      import { client } from '../../../model/client';
      import type { Runner } from '../../../model/core-agent/runner';
    `;

    expect(importSpecifiers(source).filter(isBannedKernelImport)).toEqual([
      '../../group_chat/bus',
      '#core-agent',
      '../../../model/client',
      '../../../model/core-agent/runner',
    ]);
  });

  it('does not import group chat, core-agent, or model client from kernel files', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(kernelRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      const bannedImport = importSpecifiers(source).find(isBannedKernelImport);
      if (bannedImport) {
        offenders.push(`${path.relative(process.cwd(), file)} imports ${bannedImport}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

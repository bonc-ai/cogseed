import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_CONCURRENCY,
  DEFAULT_RUNTIME_KERNEL_CONFIG,
  DEFAULT_RUNTIME_TOOL_POLICY,
} from '../../../../../src/main/features/cogseed_runtime/kernel/config';

import type {
  RuntimeKernelEvent,
  RuntimeKernelRequest,
  RuntimeToolPolicy,
} from '../../../../../src/main/features/cogseed_runtime/kernel/types';

describe('Mate Agent Runtime native kernel config', () => {
  it('starts from least-privilege tool policy', () => {
    expect(DEFAULT_RUNTIME_TOOL_POLICY).toEqual({
      fileRead: 'explicit_roots',
      fileWrite: 'none',
      shell: 'none',
      skillRun: 'none',
      network: 'none',
      connectors: 'none',
    } satisfies RuntimeToolPolicy);
  });

  it('defines explicit execution bounds', () => {
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.streamIdleTimeoutMs).toBe(3 * 60 * 1000);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.maxToolRounds).toBe(80);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.maxModelRetries).toBe(2);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowWriteToolsByDefault).toBe(false);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowShellByDefault).toBe(false);
    expect(DEFAULT_RUNTIME_KERNEL_CONFIG.allowSkillRunByDefault).toBe(false);
  });

  it('serializes one run per runtime session by default', () => {
    expect(DEFAULT_RUNTIME_CONCURRENCY).toEqual({
      maxConcurrentRuns: 3,
      maxConcurrentRunsPerUser: 2,
      maxConcurrentRunsPerSession: 1,
    });
  });

  it('keeps kernel request/event contracts free of Mate Agent conversation identity', () => {
    const request: RuntimeKernelRequest = {
      userId: 'u1',
      requestId: 'req-a',
      runtimeSessionId: 'mruntime-a',
      task: 'Do work',
      context: [],
      attachments: [],
      readOnlyRoots: [],
      writableRoots: [],
      toolPolicy: DEFAULT_RUNTIME_TOOL_POLICY,
    };
    const event: RuntimeKernelEvent = {
      type: 'started',
      requestId: request.requestId,
      runtimeSessionId: request.runtimeSessionId,
    };
    type ForbiddenKeys = 'cid' | 'conversationId' | 'conversation_id';
    type HasForbidden<T> = Extract<keyof T, ForbiddenKeys>;
    type AssertNoForbiddenKeys<T extends never> = T;
    type RequestForbiddenKeys = AssertNoForbiddenKeys<HasForbidden<RuntimeKernelRequest>>;
    type EventForbiddenKeys = AssertNoForbiddenKeys<HasForbidden<RuntimeKernelEvent>>;
    const requestForbiddenKeys: RequestForbiddenKeys[] = [];
    const eventForbiddenKeys: EventForbiddenKeys[] = [];
    expect(requestForbiddenKeys).toEqual([]);
    expect(eventForbiddenKeys).toEqual([]);

    const requestJson = JSON.stringify(request);
    const eventJson = JSON.stringify(event);
    expect(requestJson).not.toContain('cid');
    expect(requestJson).not.toContain('gconv');
    expect(eventJson).not.toContain('cid');
    expect(eventJson).not.toContain('gconv');
  });
});

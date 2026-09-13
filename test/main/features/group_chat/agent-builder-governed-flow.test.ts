import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreatorLifecycleService } from '../../../../src/main/features/creator/lifecycle-service';
import type { CreatorPresetDraft } from '../../../../src/main/features/creator/store';
import type { CreatorVerificationReport } from '../../../../src/main/features/creator/verification-service';
import {
  continueGovernedAgentBuilderFlow,
  isGovernedConfirmation,
  startGovernedAgentBuilderFlow,
  type GovernedFlowDependencies,
} from '../../../../src/main/features/group_chat/agent-builder-governed-flow';
import { readBuilderFlow, writeBuilderFlow } from '../../../../src/main/features/group_chat/agent-builder-state';

const roots: string[] = [];
const NOW = '2026-08-27T00:00:00.000Z';

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-governed-flow-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function draft(id = 'draft-1'): CreatorPresetDraft {
  return {
    schemaVersion: 1,
    draftId: id,
    updatedAt: NOW,
    manifest: {
      schemaVersion: 1,
      presetId: 'preset-1',
      version: '1.0.0',
      displayName: '报销审核',
      description: '审核报销材料',
      presetType: 'cogseed-agent',
      agent: {
        category: 'general',
        description_zh: '审核报销材料',
        description_en: 'Review expense documents',
        inputs: [{ id: 'material', type: 'file', label: '材料' }],
      },
      model: { providerId: 'provider', modelId: 'model' },
      capabilities: [],
      prompt: { systemSections: ['读取 material。停止规则：高风险转人工。失败行为：说明原因。'] },
      runtime: {
        sessionPolicy: 'new-per-run', memoryPolicy: 'none', loopPolicy: 'single-agent',
        sandboxProfile: 'creator-read-only-v1', timeoutMs: 60_000, budget: { maxTokens: 1000 },
      },
      permissions: { tools: [], files: [], sideEffects: [], approvalMode: 'always' },
      provenance: { createdBy: 'creator-agent', sourceSessionId: 'chat-1', sourceAssetRefs: [] },
    },
  };
}

function report(status: CreatorVerificationReport['status'] = 'passed'): CreatorVerificationReport {
  const ids = [
    'schema', 'catalog-resolution', 'tool-allow-list', 'file-grants', 'side-effects', 'budget',
    'timeout', 'cancel', 'idempotency', 'audit-trajectory', 'agent-usefulness',
  ] as const;
  return {
    schemaVersion: 1,
    runId: 'verify-1',
    presetId: 'preset-1',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    status,
    checks: ids.map((id) => ({ id, status: status === 'passed' ? 'passed' : 'failed', evidence: ['fixture'] })),
    startedAt: NOW,
    completedAt: NOW,
  };
}

function lifecycleFixture(order: string[] = []): CreatorLifecycleService {
  return {
    sandboxPreset: vi.fn(async () => {
      order.push('sandbox');
      return { schemaVersion: 1, status: 'sandboxed', presetId: 'preset-1', manifestDigest: `sha256:${'a'.repeat(64)}`, updatedAt: NOW, draftId: 'draft-1' };
    }),
    recordVerification: vi.fn(async (_u, _d, value) => {
      order.push('recordVerification');
      return { schemaVersion: 1, status: value.status === 'passed' ? 'verified' : 'rejected', presetId: 'preset-1', manifestDigest: value.manifestDigest, updatedAt: NOW, draftId: 'draft-1', verificationRunId: value.runId };
    }),
    approvePreset: vi.fn(async () => {
      order.push('approve');
      return { schemaVersion: 1, status: 'approved', presetId: 'preset-1', manifestDigest: `sha256:${'a'.repeat(64)}`, updatedAt: NOW, draftId: 'draft-1', verificationRunId: 'verify-1' };
    }),
    publishPreset: vi.fn(async () => {
      order.push('publish');
      return { schemaVersion: 1, status: 'published', presetId: 'preset-1', version: '1.0.0', manifestDigest: `sha256:${'b'.repeat(64)}`, updatedAt: NOW, draftId: 'draft-1', verificationRunId: 'verify-1' };
    }),
    activatePreset: vi.fn(async () => {
      order.push('activate');
      return { schemaVersion: 1, status: 'active', presetId: 'preset-1', version: '1.0.0', manifestDigest: `sha256:${'b'.repeat(64)}`, updatedAt: NOW };
    }),
    disablePreset: vi.fn(),
    rollbackPreset: vi.fn(),
    captureActiveSnapshot: vi.fn(),
  } as unknown as CreatorLifecycleService;
}

async function start(root: string, deps: GovernedFlowDependencies = {}) {
  const value = draft();
  return startGovernedAgentBuilderFlow({
    userId: 'u1', cid: 'c1', agentId: '287ce6012204', fields: { name: '报销审核', workflow: 'workflow', mode: 'governed' }, sourceSessionId: 'chat-1',
  }, {
    state: { dir: root },
    now: () => NOW,
    containerToDraft: async () => value,
    readDraft: async () => value,
    ...deps,
  });
}

describe('governed Agent builder flow', () => {
  it('creates one draft and reserves awaiting_confirm for concurrent starts', async () => {
    const root = await tempRoot();
    const containerToDraft = vi.fn(async () => draft());
    const [a, b] = await Promise.all([
      start(root, { containerToDraft }),
      start(root, { containerToDraft }),
    ]);
    expect(containerToDraft).toHaveBeenCalledTimes(1);
    expect([a.stage, b.stage]).toEqual(['awaiting_confirm', 'awaiting_confirm']);
    expect([a.message, b.message].some((message) => message?.includes('已有一个'))).toBe(true);
    expect(await readBuilderFlow('u1', 'c1', { dir: root })).toMatchObject({ stage: 'awaiting_confirm', draftId: 'draft-1' });
  });

  it('runs sandbox, verify, record, and smoke in order before final confirmation', async () => {
    const root = await tempRoot();
    const order: string[] = [];
    const lifecycle = lifecycleFixture(order);
    const verify = vi.fn(async () => { order.push('verify'); return report(); });
    const smoke = vi.fn(async (_u, _agent, smokeDeps) => {
      order.push('smoke');
      expect(smokeDeps.abortSignal).toBeInstanceOf(AbortSignal);
      return { runId: 'smoke-1', status: 'passed' as const, message: 'ok' };
    });
    await start(root);
    const controller = new AbortController();
    const result = await continueGovernedAgentBuilderFlow('u1', 'c1', '确认', controller.signal, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), buildCatalog: async () => [], verify, smoke, lifecycle,
    });
    expect(result.stage).toBe('awaiting_final_confirm');
    expect(order).toEqual(['sandbox', 'verify', 'recordVerification', 'smoke']);
    expect(await readBuilderFlow('u1', 'c1', { dir: root })).toMatchObject({ stage: 'awaiting_final_confirm', verificationRunId: 'verify-1', smokeRunId: 'smoke-1' });
  });

  it('keeps the draft and fails without smoke when Creator verification fails', async () => {
    const root = await tempRoot();
    const lifecycle = lifecycleFixture();
    const smoke = vi.fn();
    await start(root);
    const result = await continueGovernedAgentBuilderFlow('u1', 'c1', 'confirm', undefined, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), buildCatalog: async () => [], verify: async () => report('failed'), smoke, lifecycle,
    });
    expect(result.stage).toBe('failed');
    expect(result.draft?.draftId).toBe('draft-1');
    expect(smoke).not.toHaveBeenCalled();
    expect(await readBuilderFlow('u1', 'c1', { dir: root })).toMatchObject({ stage: 'failed', draftId: 'draft-1' });
  });

  it('keeps the draft when the tool-free smoke run fails', async () => {
    const root = await tempRoot();
    await start(root);
    const result = await continueGovernedAgentBuilderFlow('u1', 'c1', '确认配置', undefined, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), buildCatalog: async () => [], verify: async () => report(),
      smoke: async () => ({ runId: 'smoke-1', status: 'failed', message: 'empty' }), lifecycle: lifecycleFixture(),
    });
    expect(result.stage).toBe('failed');
    expect(result.message).toContain('未发布、未材料化');
    expect(await readBuilderFlow('u1', 'c1', { dir: root })).toMatchObject({ stage: 'failed', draftId: 'draft-1' });
  });

  it('does not materialize until final confirmation, then approve/publish/materialize/activate', async () => {
    const root = await tempRoot();
    const order: string[] = [];
    const lifecycle = lifecycleFixture(order);
    const materialize = vi.fn(async () => { order.push('materialize'); return {} as never; });
    await start(root);
    await continueGovernedAgentBuilderFlow('u1', 'c1', '确认', undefined, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), buildCatalog: async () => [], verify: async () => report(),
      smoke: async () => ({ runId: 'smoke-1', status: 'passed', message: 'ok' }), lifecycle, materialize,
    });
    expect(materialize).not.toHaveBeenCalled();
    const prompt = await continueGovernedAgentBuilderFlow('u1', 'c1', '普通文本', undefined, { state: { dir: root }, now: () => NOW });
    expect(prompt.stage).toBe('awaiting_final_confirm');
    expect(materialize).not.toHaveBeenCalled();
    const result = await continueGovernedAgentBuilderFlow('u1', 'c1', '确认落地', undefined, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), lifecycle, materialize,
    });
    expect(result.stage).toBe('done');
    expect(order.slice(-4)).toEqual(['approve', 'publish', 'materialize', 'activate']);
  });

  it('cancels without materialization and expires stale state', async () => {
    const root = await tempRoot();
    const materialize = vi.fn();
    await start(root);
    const cancelled = await continueGovernedAgentBuilderFlow('u1', 'c1', '取消', undefined, { state: { dir: root }, now: () => NOW, materialize });
    expect(cancelled.stage).toBe('failed');
    expect(materialize).not.toHaveBeenCalled();

    await writeBuilderFlow('u1', 'c2', {
      version: 1, cid: 'c2', agentId: '287ce6012204', mode: 'governed', stage: 'awaiting_confirm', draftId: 'draft-2',
      expiresAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    }, { dir: root });
    const expired = await continueGovernedAgentBuilderFlow('u1', 'c2', '确认', undefined, { state: { dir: root }, now: () => NOW });
    expect(expired.stage).toBe('expired');
    expect(expired.message).toContain('重新提交');
  });

  it('never enters materialize after the abort signal fires during publish', async () => {
    const root = await tempRoot();
    const controller = new AbortController();
    const lifecycle = lifecycleFixture();
    await start(root);
    await continueGovernedAgentBuilderFlow('u1', 'c1', '确认', undefined, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), buildCatalog: async () => [], verify: async () => report(),
      smoke: async () => ({ runId: 'smoke-1', status: 'passed', message: 'ok' }), lifecycle,
    });
    (lifecycle.publishPreset as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      controller.abort();
      return { schemaVersion: 1, status: 'published', presetId: 'preset-1', version: '1.0.0', manifestDigest: `sha256:${'b'.repeat(64)}`, updatedAt: NOW };
    });
    const materialize = vi.fn();
    const result = await continueGovernedAgentBuilderFlow('u1', 'c1', '发布', controller.signal, {
      state: { dir: root }, now: () => NOW, readDraft: async () => draft(), lifecycle, materialize,
    });
    expect(result.stage).toBe('failed');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('recognizes only explicit confirmation/cancellation phrases', () => {
    expect(isGovernedConfirmation('  确认落地  ')).toBe(true);
    expect(isGovernedConfirmation('OK')).toBe(true);
    expect(isGovernedConfirmation('取消创建')).toBe(true);
    expect(isGovernedConfirmation('我想确认一下配置')).toBe(false);
  });
});

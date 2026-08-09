import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

let uid = '';

beforeEach(() => { uid = `contrast-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import('../../../../src/main/paths');
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

describe('P3394 baseline/treatment behavior contrast', () => {
  it('runs the same normalized input twice with isolated context modes and completes the receipt', async () => {
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    const contrasts = await import('../../../../src/main/features/p3394/behavior-contrast');
    const executions = await import('../../../../src/main/features/execution-records');
    const artifacts = await import('../../../../src/main/features/chat_artifacts');

    await receipts.prepareReceipt(uid, {
      receiptId: 'receipt-contrast-1',
      executionId: 'receipt-execution-1',
      sourceSessionId: 'gconv-source',
      sourceContextId: 'ctx-source',
      targetSessionId: 'gmember-target',
      targetContextId: 'ctx-target',
      reusedRefs: ['memory:decision-1', 'artifact:prior-1'],
      omittedRefs: ['memory:private-1'],
      permissionMode: 'workspace-write',
      allowedScopes: ['workspace:read', 'workspace:write', 'artifacts'],
      boundary: 'test-double',
    }, { sessionId: 'gmember-target', contextId: 'ctx-target' });

    const baselineArtifact = artifacts.createArtifact(uid, 'conversation-1', 'agent-1', {
      title: 'Baseline result', files: [{ path: 'index.html', content: '<title>baseline</title>' }],
    });
    const treatmentArtifact = artifacts.createArtifact(uid, 'conversation-1', 'agent-1', {
      title: 'Treatment result', files: [{ path: 'index.html', content: '<title>treatment</title>' }],
    });
    expect(baselineArtifact.ok && treatmentArtifact.ok).toBe(true);
    if (!baselineArtifact.ok || !treatmentArtifact.ok) throw new Error('artifact setup failed');

    const calls: any[] = [];
    const contrast = await contrasts.runBehaviorContrast(uid, {
      contrastId: 'contrast-1',
      receiptExecutionId: 'receipt-execution-1',
      task: '  Compare   this task\ncarefully  ',
      attachmentIds: ['attachment-b', 'attachment-a', 'attachment-a'],
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      executionKind: 'core-agent',
      boundary: 'test-double',
    }, async (request) => {
      calls.push(request);
      return request.contextMode === 'baseline'
        ? { status: 'completed', output: 'baseline output', artifacts: [{ cid: 'conversation-1', artifactId: baselineArtifact.artifactId, title: baselineArtifact.title }] }
        : { status: 'completed', output: 'treatment output', artifacts: [{ cid: 'conversation-1', artifactId: treatmentArtifact.artifactId, title: treatmentArtifact.title }] };
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ contextMode: 'baseline', task: 'Compare this task carefully', reusedRefs: [] });
    expect(calls[1]).toMatchObject({ contextMode: 'treatment', task: 'Compare this task carefully', reusedRefs: ['memory:decision-1', 'artifact:prior-1'] });
    expect(calls[0].attachmentIds).toEqual(['attachment-a', 'attachment-b']);
    expect(calls[1].attachmentIds).toEqual(calls[0].attachmentIds);
    expect(calls[0].executionId).not.toBe(calls[1].executionId);

    expect(contrast).toMatchObject({
      contrastId: 'contrast-1',
      receiptId: 'receipt-contrast-1',
      changed: true,
      boundary: 'test-double',
      baseline: { status: 'completed', artifactIds: [baselineArtifact.artifactId] },
      treatment: { status: 'completed', artifactIds: [treatmentArtifact.artifactId] },
    });
    expect(contrast.sameInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await contrasts.readBehaviorContrast(uid, 'contrast-1')).toEqual(contrast);
    expect(contrasts.behaviorContrastPath(uid, 'contrast-1')).toContain(
      path.join(uid, 'local', 'kstar', 'executions', 'contrasts', 'contrast-1.json'),
    );

    const receipt = await receipts.readReceipt(uid, 'receipt-execution-1');
    expect(receipt).toMatchObject({
      status: 'completed',
      baselineExecutionId: contrast.baselineExecutionId,
      treatmentExecutionId: contrast.treatmentExecutionId,
    });
    expect(await executions.read(uid, contrast.baselineExecutionId)).toMatchObject({ status: 'completed', artifactIds: [baselineArtifact.artifactId] });
    expect(await executions.read(uid, contrast.treatmentExecutionId)).toMatchObject({ status: 'completed', artifactIds: [treatmentArtifact.artifactId] });
  });

  it('rejects a finalized receipt and invalid identifiers before dispatch', async () => {
    const contrasts = await import('../../../../src/main/features/p3394/behavior-contrast');
    await expect(contrasts.runBehaviorContrast(uid, {
      contrastId: '../escape', receiptExecutionId: 'missing', task: 'x', attachmentIds: [],
      conversationId: 'conversation-1', executionKind: 'core-agent', boundary: 'test-double',
    }, async () => ({ status: 'completed', output: 'x', artifacts: [] }))).rejects.toThrow(/contrast id/i);
  });
});

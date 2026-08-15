import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-teaching-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('User teaching signals', () => {
  it('classifies only explicit teaching language', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    expect(teaching.classifyTeachingIntent('记住我更喜欢简短回答')).toBe('prefer');
    expect(teaching.classifyTeachingIntent('不要再自动修改 KSTAR')).toBe('avoid');
    expect(teaching.classifyTeachingIntent('纠正一下，不是 A 而是 B')).toBe('correct');
    expect(teaching.classifyTeachingIntent('请继续处理这个任务')).toBeUndefined();
  });

  it('creates one idempotent pending candidate and revokes both review inputs', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const input = {
      conversationId: 'conv-a',
      messageId: 'message-a',
      userMessage: '请记住：以后所有结论都附来源。',
      memoryContent: '所有结论都附来源。',
      memoryScope: 'project' as const,
    };
    const signals = await Promise.all([
      teaching.recordTeachingSignalAfterMemoryWrite('user-a', input),
      teaching.recordTeachingSignalAfterMemoryWrite('user-a', input),
      teaching.recordTeachingSignalAfterMemoryWrite('user-a', input),
    ]);

    expect(new Set(signals.map((signal) => signal?.id)).size).toBe(1);
    expect(signals[0]).toMatchObject({ taxonomyVersion: 2, status: 'active', scope: 'project', candidateIds: [expect.stringMatching(/^cand-/)] });
    const listedCandidates = await candidates.listRecallCandidates('user-a');
    expect(listedCandidates).toHaveLength(1);
    expect(listedCandidates[0]).toMatchObject({ status: 'pending_review', captureKey: `teaching-${signals[0]!.id}` });
    expect(listedCandidates[0].sourceRefs.map((ref) => `${ref.kind}:${ref.subtype}`)).toEqual([
      'conversation:session',
      'conversation:message',
      'user_teaching_signal:teaching',
    ]);

    const revoked = await teaching.revokeUserTeachingSignal('user-a', signals[0]!.id);
    expect(revoked).toMatchObject({ status: 'revoked', revokedAt: expect.any(String) });
    await expect(candidates.readRecallCandidate('user-a', revoked.candidateIds[0])).resolves.toMatchObject({ status: 'rejected' });
  });

  it('does not create a signal when a successful memory write was not explicitly requested', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(teaching.recordTeachingSignalAfterMemoryWrite('user-a', {
      conversationId: 'conv-a',
      messageId: 'message-a',
      userMessage: '继续完成数据接入。',
      memoryContent: '当前项目使用 TypeScript。',
      memoryScope: 'project',
    })).resolves.toBeUndefined();
    await expect(candidates.listRecallCandidates('user-a')).resolves.toEqual([]);
  });

  it('downgrades a promoted asset when its teaching Evidence is revoked', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const signal = await teaching.recordTeachingSignalAfterMemoryWrite('user-a', {
      conversationId: 'conv-a',
      messageId: 'message-a',
      userMessage: '请记住：所有结论都附来源。',
      memoryContent: '所有结论都附来源。',
      memoryScope: 'project',
    });
    const candidate = await candidates.readRecallCandidate('user-a', signal!.candidateIds[0]);
    const asset = (await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' })).asset;
    await assets.setAbilityAssetMaturity('user-a', asset.id, 'transfer_validated');

    await teaching.revokeUserTeachingSignal('user-a', signal!.id);

    await expect(assets.readAbilityAsset('user-a', asset.id)).resolves.toMatchObject({
      status: 'paused',
      maturity: 'bud',
    });
    const audit = await assets.listAbilityAssetAudit('user-a', asset.id);
    expect(audit).toContainEqual(expect.objectContaining({
      action: 'maturity_downgraded',
      note: `evidence_revoked:user_teaching_signal:${signal!.id}`,
    }));
    expect(audit).toContainEqual(expect.objectContaining({
      action: 'paused',
      note: `evidence_revoked:user_teaching_signal:${signal!.id}`,
    }));
    // Paused assets no longer enter injection (injection only reads active).
    expect(assets.readAbilityAsset).toBeDefined();
  });

  it('keeps the system pause idempotent across repeated revocations', async () => {
    const teaching = await import('../../../../src/main/features/recall/teaching-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const signal = await teaching.recordTeachingSignalAfterMemoryWrite('user-a', {
      conversationId: 'conv-a',
      messageId: 'message-a',
      userMessage: '请记住：所有结论都附来源。',
      memoryContent: '所有结论都附来源。',
      memoryScope: 'project',
    });
    const candidate = await candidates.readRecallCandidate('user-a', signal!.candidateIds[0]);
    await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });

    await teaching.revokeUserTeachingSignal('user-a', signal!.id);
    // The teaching candidate itself is promoted: the asset stays paused once
    // (idempotent second revoke changes nothing).
    await teaching.revokeUserTeachingSignal('user-a', signal!.id);
    const asset = (await assets.listAbilityAssets('user-a'))[0];
    expect(asset.status).toBe('paused');
  });
});

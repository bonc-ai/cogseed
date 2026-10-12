import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-improvement-outcome-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [outcome, paths] = await Promise.all([
    import('../../../../src/main/features/kstar/improvement-outcome'),
    import('../../../../src/main/features/kstar/paths'),
  ]);
  return { outcome, paths };
}

function outcomeFile(paths: { kstarRecordPath: (uid: string, collection: string, id: string) => string },
  episodeId: string, userId = 'user-a'): string {
  return paths.kstarRecordPath(userId, 'improvement-outcomes', `kio-${episodeId}`);
}

function readRaw(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('KSTAR improvement outcomes', () => {
  it('overwrites the derived record for the same episode and keeps exactly one file', async () => {
    const { outcome, paths } = await modules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T01:00:00.000Z'));

    const first = await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-a', reviewId: 'ksr-a', conclusion: 'insufficient_evidence',
      reason: '本任务没有可核对的采用记录',
    });
    expect(first.id).toBe('kio-kse-a');
    const file = outcomeFile(paths, 'kse-a');
    // 派生 id + 集合路径的存储形状（`<uid>/cloud/kstar/improvement-outcomes/<id>.json`）。
    expect(file).toBe(path.join(tmpDir, 'user-a', 'cloud', 'kstar', 'improvement-outcomes', 'kio-kse-a.json'));
    expect(fs.readdirSync(path.dirname(file))).toEqual(['kio-kse-a.json']);

    vi.setSystemTime(new Date('2026-09-25T01:05:00.000Z'));
    const second = await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-a', reviewId: 'ksr-a', conclusion: 'no_update',
      reason: '任务结果达到预期，方法无需更新',
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe('2026-09-25T01:05:00.000Z');
    // 同 episode 重复分析 = 覆盖同一条：盘上仍只有一个文件，列表只有一条。
    expect(fs.readdirSync(path.dirname(file))).toEqual(['kio-kse-a.json']);
    const listed = await outcome.listKstarImprovementOutcomes('user-a');
    expect(listed).toHaveLength(1);
    expect(listed[0].conclusion).toBe('no_update');
    expect((await outcome.readKstarImprovementOutcome('user-a', 'kse-a')).reason).toBe('任务结果达到预期，方法无需更新');

    // 时钟回拨也不许让 updatedAt 倒退（列表倒序靠它判定）。
    vi.setSystemTime(new Date('2026-09-25T00:59:00.000Z'));
    const third = await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-a', reviewId: 'ksr-a', conclusion: 'no_update', reason: '重复分析结果一致',
    });
    expect(third.createdAt).toBe(first.createdAt);
    expect(third.updatedAt.localeCompare(second.updatedAt)).toBeGreaterThan(0);
  });

  it('never persists restricted asset body text or secrets, only a bounded summary', async () => {
    const { outcome, paths } = await modules();
    const restrictedTail = 'RSTR-REASON-TAIL-请勿落盘';
    const excerptTail = 'RSTR-EXCERPT-TAIL-请勿落盘';
    const restrictedBody = `方法论正文（内部受限）：${'步骤细节-'.repeat(80)}${restrictedTail}`;
    expect(restrictedBody.length).toBeGreaterThan(400);

    await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-body', reviewId: 'ksr-body', conclusion: 'insufficient_evidence',
      // 调用方误把受限资产正文当摘要传进来：只留前 240 字的压缩摘要，正文尾部永不落盘。
      reason: restrictedBody,
      evidenceRefs: [{ kind: 'execution_evaluation', id: 'run-a', excerpt: `证据片段：${excerptTail}` }],
    });
    const bodyRaw = readRaw(outcomeFile(paths, 'kse-body'));
    expect(bodyRaw).not.toContain(restrictedBody);
    expect(bodyRaw).not.toContain(restrictedTail);
    const bodyRecord = JSON.parse(bodyRaw) as { reason: string; evidenceRefs: Array<Record<string, unknown>> };
    expect(bodyRecord.reason.length).toBeLessThanOrEqual(240);
    expect(bodyRecord.reason).toContain('方法论正文');
    // 证据引用只落元数据：引用 id 保留，摘录正文与绝对路径一律不落盘。
    expect(bodyRecord.evidenceRefs).toEqual([expect.objectContaining({ kind: 'execution_evaluation', id: 'run-a' })]);
    expect('excerpt' in bodyRecord.evidenceRefs[0]).toBe(false);
    expect(bodyRaw).not.toContain(excerptTail);

    await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-secret', reviewId: 'ksr-secret', conclusion: 'analysis_failed',
      failureCategory: 'model',
      reason: '模型调用失败：api_key = sk-live-abcd12345678',
    });
    const secretRaw = readRaw(outcomeFile(paths, 'kse-secret'));
    expect(secretRaw).not.toContain('sk-live-abcd12345678');
    expect(secretRaw).toContain('[REDACTED]');
  });

  it('round-trips all four conclusions with adoption summaries as ids only', async () => {
    const { outcome } = await modules();
    const cases = [
      { episodeId: 'kse-no-update', conclusion: 'no_update', reason: '结果达到预期，方法无需更新' },
      { episodeId: 'kse-insufficient', conclusion: 'insufficient_evidence', reason: '没有实际采用记录可核对' },
      { episodeId: 'kse-analysis-failed', conclusion: 'analysis_failed', reason: '证据读取失败', failureCategory: 'model' },
      { episodeId: 'kse-submit-failed', conclusion: 'submit_failed', reason: '候选写入失败', failureCategory: 'workflow' },
    ] as const;
    for (const entry of cases) {
      const record = await outcome.recordKstarImprovementOutcome('user-a', {
        ...entry, reviewId: `ksr-${entry.episodeId}`,
        requirementId: entry.conclusion === 'no_update' ? 'ksreq-a' : undefined,
        taskId: 'kst-a',
        conversationId: 'conversation-a',
        adoptedAssetRefs: entry.conclusion === 'insufficient_evidence'
          ? [
            { assetId: 'asset-method-a', assetVersion: '2', usageReceiptId: 'aur-1' },
            { assetId: 'asset-method-a', assetVersion: '2', usageReceiptId: 'aur-1' },
            { assetId: '../escape', assetVersion: '1', usageReceiptId: 'aur-2' },
          ]
          : undefined,
      });
      expect(record.conclusion).toBe(entry.conclusion);
      const read = await outcome.readKstarImprovementOutcome('user-a', entry.episodeId);
      expect(read.conclusion).toBe(entry.conclusion);
      expect(read.reason).toBe(entry.reason);
      expect(read.taskId).toBe('kst-a');
      expect(read.conversationId).toBe('conversation-a');
    }

    const noUpdate = await outcome.readKstarImprovementOutcome('user-a', 'kse-no-update');
    expect(noUpdate.requirementId).toBe('ksreq-a');
    expect(noUpdate.failureCategory).toBeUndefined();
    expect(noUpdate.evidenceRefs).toEqual([]);
    expect(noUpdate.adoptedAssetRefs).toBeUndefined();

    // 采用摘要去重且只留合法标识（非法 id 项被丢弃，不落正文）。
    const insufficient = await outcome.readKstarImprovementOutcome('user-a', 'kse-insufficient');
    expect(insufficient.adoptedAssetRefs).toEqual([
      { assetId: 'asset-method-a', assetVersion: '2', usageReceiptId: 'aur-1' },
    ]);
    expect(insufficient.requirementId).toBeUndefined();
    expect((await outcome.listKstarImprovementOutcomes('user-a'))).toHaveLength(4);
  });

  it('requires a failure category for analysis_failed and submit_failed', async () => {
    const { outcome, paths } = await modules();
    await expect(outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-analysis-failed', reviewId: 'ksr-a', conclusion: 'analysis_failed', reason: '推理失败',
    })).rejects.toThrow(/failureCategory/i);
    await expect(outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-submit-failed', reviewId: 'ksr-a', conclusion: 'submit_failed', reason: '提交失败',
    })).rejects.toThrow(/failureCategory/i);
    // 缺归因的写入不落任何文件（不许退化成无归因结论）。
    expect(fs.existsSync(outcomeFile(paths, 'kse-analysis-failed'))).toBe(false);
    expect(fs.existsSync(outcomeFile(paths, 'kse-submit-failed'))).toBe(false);

    await expect(outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-submit-failed', reviewId: 'ksr-a', conclusion: 'submit_failed',
      reason: '提交失败', failureCategory: 'nonsense',
    })).rejects.toThrow(/invalid/i);

    const written = await outcome.recordKstarImprovementOutcome('user-a', {
      episodeId: 'kse-submit-failed', reviewId: 'ksr-a', conclusion: 'submit_failed',
      reason: '候选写入失败', failureCategory: 'workflow',
    });
    expect(written.failureCategory).toBe('workflow');
    expect((await outcome.readKstarImprovementOutcome('user-a', 'kse-submit-failed')).failureCategory).toBe('workflow');
  });

  it('lists newest-first with limit and conclusion filters', async () => {
    const { outcome } = await modules();
    vi.useFakeTimers({ toFake: ['Date'] });
    const write = async (episodeId: string, at: string, conclusion: string, failureCategory?: string) => {
      vi.setSystemTime(new Date(at));
      return outcome.recordKstarImprovementOutcome('user-a', {
        episodeId, reviewId: `ksr-${episodeId}`, conclusion, reason: `结论摘要 ${episodeId}`, failureCategory,
      });
    };
    await write('kse-old', '2026-09-25T02:00:00.000Z', 'no_update');
    await write('kse-mid', '2026-09-25T02:01:00.000Z', 'analysis_failed', 'model');
    await write('kse-new', '2026-09-25T02:02:00.000Z', 'insufficient_evidence');

    const list = (options?: { limit?: number; conclusion?: string }) =>
      outcome.listKstarImprovementOutcomes('user-a', options as never);
    expect((await list()).map((row: { episodeId: string }) => row.episodeId)).toEqual(['kse-new', 'kse-mid', 'kse-old']);
    expect((await list({ limit: 2 })).map((row: { episodeId: string }) => row.episodeId)).toEqual(['kse-new', 'kse-mid']);
    expect((await list({ conclusion: 'analysis_failed' })).map((row: { episodeId: string }) => row.episodeId)).toEqual(['kse-mid']);
    expect(await list({ conclusion: 'submit_failed' })).toEqual([]);
    // 覆盖写会把旧记录按新的 updatedAt 重新排到最前。
    await write('kse-old', '2026-09-25T02:03:00.000Z', 'no_update');
    expect((await list()).map((row: { episodeId: string }) => row.episodeId)).toEqual(['kse-old', 'kse-new', 'kse-mid']);
    expect((await list({ conclusion: 'insufficient_evidence', limit: 1 })).map((row: { episodeId: string }) => row.episodeId))
      .toEqual(['kse-new']);

    await expect(list({ limit: 0 })).rejects.toThrow(/limit/i);
    await expect(list({ conclusion: 'bogus' })).rejects.toThrow(/invalid/i);
  });

  it('rejects unsafe identifiers, empty reasons, and isolates owners and degraded records', async () => {
    const { outcome, paths } = await modules();
    const base = { reviewId: 'ksr-a', conclusion: 'no_update' as const, reason: '无需更新' };
    for (const episodeId of ['../escape', 'nested/value', 'bad.value', '', ' user ']) {
      await expect(outcome.recordKstarImprovementOutcome('user-a', { ...base, episodeId }))
        .rejects.toThrow(/invalid kstar improvement outcome reference/i);
    }
    await expect(outcome.recordKstarImprovementOutcome('user-a', { ...base, episodeId: 'kse-a', reviewId: '../escape' }))
      .rejects.toThrow(/invalid kstar improvement outcome reference/i);
    await expect(outcome.recordKstarImprovementOutcome('user/a', { ...base, episodeId: 'kse-a' }))
      .rejects.toThrow(/invalid kstar improvement outcome reference/i);
    await expect(outcome.recordKstarImprovementOutcome('user-a', { ...base, episodeId: 'kse-a', conclusion: 'bogus' } as never))
      .rejects.toThrow(/invalid kstar improvement outcome reference/i);
    await expect(outcome.recordKstarImprovementOutcome('user-a', { ...base, episodeId: 'kse-a', reason: '   ' }))
      .rejects.toThrow(/reason/i);
    await expect(outcome.readKstarImprovementOutcome('user-a', '../escape'))
      .rejects.toThrow(/invalid kstar improvement outcome episode id/i);
    expect(fs.existsSync(path.dirname(outcomeFile(paths, 'kse-a')))).toBe(false);
    expect(await outcome.listKstarImprovementOutcomes('user-a')).toEqual([]);

    await outcome.recordKstarImprovementOutcome('user-a', { ...base, episodeId: 'kse-a' });
    // 用户隔离：别人的域里读不到、也列不出。
    expect(await outcome.readKstarImprovementOutcome('user-b', 'kse-a')).toBeNull();
    expect(await outcome.listKstarImprovementOutcomes('user-b')).toEqual([]);
    expect(await outcome.readKstarImprovementOutcome('user-a', 'kse-missing')).toBeNull();

    // 降级记录跳过，不拖垮整张列表；直接读该条则抛出。
    fs.writeFileSync(outcomeFile(paths, 'kse-tampered'), JSON.stringify({
      schemaVersion: 1, ownerId: 'user-a', id: 'kio-kse-tampered', episodeId: 'kse-tampered',
      reviewId: 'ksr-a', conclusion: 'bogus', reason: 'x', evidenceRefs: [],
      createdAt: '2026-09-25T03:00:00.000Z', updatedAt: '2026-09-25T03:00:00.000Z',
    }), 'utf8');
    expect((await outcome.listKstarImprovementOutcomes('user-a')).map((row: { episodeId: string }) => row.episodeId))
      .toEqual(['kse-a']);
    await expect(outcome.readKstarImprovementOutcome('user-a', 'kse-tampered')).rejects.toThrow(/malformed kstar improvement outcome/i);
  });
});

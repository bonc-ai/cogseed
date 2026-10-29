import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
/**
 * 候选记录启动期维护：权威枚举、逐记录日志、失败重试、blocked 指纹、
 * 旧聚合标记失效、稍后处理时间截断、abort 续跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

const UID = 'user-a';
const MIGRATION_ID = 'candidate-record-contract-v2';
let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-record-migrations-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

function candidatePath(candidateId: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'candidates', `${candidateId}.json`);
}

function migrationRecordPath(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'candidate-migrations', `${id}.json`);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJournal(): { entries: Record<string, { status: string; attempts: number; fingerprint?: string }> } {
  return readJson(migrationRecordPath(MIGRATION_ID)) as never;
}

function makeLegacy(candidateId: string): void {
  const file = candidatePath(candidateId);
  const record = readJson(file);
  delete record.contentFormatVersion;
  delete record.taxonomyVersion;
  delete record.evidenceRefs;
  record.value = '旧格式里的证据说明——迁移必须无损保留。';
  fs.writeFileSync(file, JSON.stringify(record));
}

function writeDeferred(candidateId: string, updatedAt: string, extra: Record<string, unknown> = {}): void {
  const file = candidatePath(candidateId);
  const record = readJson(file);
  fs.writeFileSync(file, JSON.stringify({
    ...record,
    status: 'deferred',
    cooldownUntil: '2099-01-01T00:00:00.000Z',
    updatedAt,
    ...extra,
  }));
}

async function fixture(summary: string) {
  return createNightlyCandidateFixture(UID, {
    judgment: `启动迁移测试正文：${summary}。`,
    summary,
    value: `启动迁移测试用途：${summary}。`,
    suggestedType: 'cognition',
    suggestedScope: 'project',
    sourceRefs: [{ kind: 'conversation', id: `conv-${summary}` }],
  });
}

describe('候选记录启动期维护', () => {
  it('旧格式逐记录迁移、日志落盘，二次运行不重写', async () => {
    const candidates = await service();
    const created = await fixture('旧格式');
    makeLegacy(created.id);

    await candidates.runCandidateRecordMigrations(UID);

    const migrated = readJson(candidatePath(created.id));
    expect(migrated.contentFormatVersion).toBe(1);
    expect(migrated.taxonomyVersion).toBe(2);
    expect(Array.isArray(migrated.evidenceRefs)).toBe(true);
    expect(JSON.stringify(migrated)).toContain('旧格式里的证据说明——迁移必须无损保留。');
    expect(readJournal().entries[created.id]).toMatchObject({ status: 'applied', attempts: 1 });

    const recordText = fs.readFileSync(candidatePath(created.id), 'utf8');
    const journalText = fs.readFileSync(migrationRecordPath(MIGRATION_ID), 'utf8');
    await candidates.runCandidateRecordMigrations(UID);
    expect(fs.readFileSync(candidatePath(created.id), 'utf8')).toBe(recordText);
    expect(fs.readFileSync(migrationRecordPath(MIGRATION_ID), 'utf8')).toBe(journalText);
  });

  it('单条写失败记为 failed，下次启动重试成功', async () => {
    const candidates = await service();
    const created = await fixture('失败重试');
    makeLegacy(created.id);
    const store = await import('../../../../src/main/features/recall/store');
    const original = store.updateRecallJsonRecord;
    let injected = false;
    vi.spyOn(store, 'updateRecallJsonRecord').mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!injected && args[1] === 'candidates' && args[2] === created.id) {
        injected = true;
        throw new Error('injected disk failure');
      }
      return original(...args);
    });

    await candidates.runCandidateRecordMigrations(UID);
    expect(readJournal().entries[created.id]).toMatchObject({ status: 'failed', attempts: 1 });

    vi.restoreAllMocks();
    await candidates.runCandidateRecordMigrations(UID);
    expect(readJournal().entries[created.id]).toMatchObject({ status: 'applied', attempts: 2 });
    expect(readJson(candidatePath(created.id)).contentFormatVersion).toBe(1);
  });

  it('超长存量记为 blocked 并保存指纹；内容未变不重试，修正后自动迁移', async () => {
    const candidates = await service();
    const created = await fixture('超长正文');
    const file = candidatePath(created.id);
    const record = readJson(file);
    record.judgment = 'x'.repeat(4_001);
    fs.writeFileSync(file, JSON.stringify(record));

    await candidates.runCandidateRecordMigrations(UID);
    const blocked = readJournal().entries[created.id];
    expect(blocked.status).toBe('blocked');
    expect(blocked.attempts).toBe(1);
    expect(blocked.fingerprint).toEqual(expect.any(String));
    expect(readJson(file).judgment).toHaveLength(4_001);

    await candidates.runCandidateRecordMigrations(UID);
    expect(readJournal().entries[created.id]).toMatchObject({ status: 'blocked', attempts: 1 });

    const fixed = readJson(file);
    fixed.judgment = '修正后的完整正文。';
    fs.writeFileSync(file, JSON.stringify(fixed));
    await candidates.runCandidateRecordMigrations(UID);
    expect(readJournal().entries[created.id].status).toBe('current');
    expect(readJson(file).judgment).toBe('修正后的完整正文。');
  });

  it('旧聚合完成标记在场，仍按记录实际状态迁移', async () => {
    const candidates = await service();
    const created = await fixture('旧章失效');
    makeLegacy(created.id);
    writeJson(migrationRecordPath('candidate-content-v1'), {
      schemaVersion: 1,
      ownerId: UID,
      id: 'candidate-content-v1',
      appliedAt: '2026-09-27T15:47:16.806Z',
    });

    await candidates.runCandidateRecordMigrations(UID);

    expect(readJson(candidatePath(created.id)).contentFormatVersion).toBe(1);
    expect(readJournal().entries[created.id].status).toBe('applied');
  });

  it('只存在于统一库、投影缺失的候选仍被迁移并恢复投影', async () => {
    const candidates = await service();
    const created = await fixture('统一库唯一');
    makeLegacy(created.id);
    const migration = await import('../../../../src/main/features/cognition_migration');
    const activated = await migration.migrateLegacyCognition(UID, { activate: true });
    expect(activated.errors).toEqual([]);
    const projection = candidatePath(created.id);
    expect(fs.existsSync(projection)).toBe(true);
    fs.rmSync(projection, { force: true });

    const store = await import('../../../../src/main/features/recall/store');
    expect((await store.readRecallJsonRecord(UID, 'candidates', created.id))?.contentFormatVersion).toBeUndefined();
    await candidates.runCandidateRecordMigrations(UID);

    expect((await store.readRecallJsonRecord(UID, 'candidates', created.id))?.contentFormatVersion).toBe(1);
    expect(fs.existsSync(projection)).toBe(true);
    expect(readJournal().entries[created.id].status).toBe('applied');
  });

  it('稍后处理退役只作用于旧标记时间点之前的 deferred 记录', async () => {
    const candidates = await service();
    const older = await fixture('旧推迟');
    const newer = await fixture('新推迟');
    const held = await fixture('语义保留');
    writeDeferred(older.id, '2026-10-01T00:00:00.000Z');
    writeDeferred(newer.id, '2026-10-03T00:00:00.000Z');
    writeDeferred(held.id, '2026-10-01T00:00:00.000Z', { failureCode: 'semantic_review_flagged' });
    writeJson(migrationRecordPath('user-defer-retired-20261002'), {
      schemaVersion: 1,
      ownerId: UID,
      id: 'user-defer-retired-20261002',
      at: '2026-10-02T00:00:00.000Z',
    });

    await candidates.runCandidateRecordMigrations(UID);

    expect((await candidates.readRecallCandidate(UID, older.id)).status).toBe('pending_review');
    expect((await candidates.readRecallCandidate(UID, newer.id)).status).toBe('deferred');
    expect((await candidates.readRecallCandidate(UID, held.id)).status).toBe('deferred');
  });

  it('abort 后保留已处理日志，下次运行续跑', async () => {
    const candidates = await service();
    const created = [await fixture('中止一'), await fixture('中止二'), await fixture('中止三')];
    for (const item of created) makeLegacy(item.id);
    const controller = new AbortController();
    const store = await import('../../../../src/main/features/recall/store');
    const original = store.updateRecallJsonRecord;
    let updates = 0;
    vi.spyOn(store, 'updateRecallJsonRecord').mockImplementation(async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (args[1] === 'candidates') {
        updates += 1;
        if (updates === 1) controller.abort();
      }
      return result;
    });

    await candidates.runCandidateRecordMigrations(UID, controller.signal);
    const partial = Object.values(readJournal().entries).filter((entry) => entry.status === 'applied');
    expect(partial).toHaveLength(1);

    vi.restoreAllMocks();
    await candidates.runCandidateRecordMigrations(UID);
    expect(Object.values(readJournal().entries).filter((entry) => entry.status === 'applied')).toHaveLength(3);
  });
});

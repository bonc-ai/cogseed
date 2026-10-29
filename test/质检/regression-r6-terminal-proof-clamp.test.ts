/** 分页读口默认最多返回 20 条；需要完整证明链的消费方使用全量出口。
 * 构造 25 条已确认投影，把目标置于分页之外，对比两种读口的覆盖差异。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r6-clamp';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r6b-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadProjection() {
  return import('../../src/main/features/recall/context-projection');
}

/** 手写一条合法 confirmed 投影记录（形状过 asProjection + store 双层校验）。 */
async function writeProjection(
  writeRecallJsonRecord: typeof import('../../src/main/features/recall/store').writeRecallJsonRecord,
  id: string, taskRunId: string, createdAt: string,
) {
  await writeRecallJsonRecord(UID, 'projections', id, {
    schemaVersion: 2,
    ownerId: UID,
    id,
    taskRunId,
    purpose: 'probe',
    authorization: 'user_selected',
    assetIds: [],
    assetVersions: {},
    sourceRefs: [],
    omittedRefs: [],
    status: 'confirmed',
    createdAt,
  });
}

describe('listContextProjections 默认 clamp 20 契约与全量出口对照', () => {
  it('25 条投影（目标第 21 新）：与 recall-terminal-proof.ts:34 同参调用查不到目标，全量枚举查得到', async () => {
    const { writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
    const projection = await loadProjection();

    const TARGET = 'proj-p6target01';
    const TARGET_TURN = 'turn-p6-target';
    // 目标投影第 21 新（其后又有 20 条更新的投影），前面再垫 4 条更旧的。
    const base = Date.parse('2026-09-30T00:00:00.000Z');
    const iso = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
    for (let i = 0; i < 4; i += 1) {
      await writeProjection(writeRecallJsonRecord, `proj-p6old${String(i).padStart(2, '0')}`, `turn-old-${i}`, iso(i));
    }
    await writeProjection(writeRecallJsonRecord, TARGET, TARGET_TURN, iso(10));
    for (let i = 0; i < 20; i += 1) {
      await writeProjection(writeRecallJsonRecord, `proj-p6new${String(i).padStart(2, '0')}`, `turn-new-${i}`, iso(100 + i));
    }
    expect((await projection.listAllContextProjections(UID)).length).toBe(25); // 全量在场

    // 与 turnProjectionIds（recall-terminal-proof.ts:34）完全同参的调用形态。
    const clamped = await projection.listContextProjections(UID);
    expect(clamped.length).toBe(20); // 默认 clamp：Number(undefined)||20 → min(100,20)
    // 复刻 turnProjectionIds 的过滤体（:37-39：confirmed + taskRunId 命中 + 未过期）。
    const found = clamped
      .filter((p) => p.status === 'confirmed' && p.taskRunId === TARGET_TURN
        && !(p.expiresAt && Date.parse(p.expiresAt) <= Date.now()))
      .map((p) => p.id);
    expect(found).toEqual([]); // 目标 turn 的投影不在输入池 → 反查扑空，证明锚点漏

    // 对照：全量枚举（listAllContextProjections）下同样的过滤能找到目标——
    // 修复出口（换成全量或带 taskRunId 查询的调用）在本仓库已存在。
    const foundAll = (await projection.listAllContextProjections(UID))
      .filter((p) => p.status === 'confirmed' && p.taskRunId === TARGET_TURN)
      .map((p) => p.id);
    expect(foundAll).toEqual([TARGET]);
  });

  it('对照组：目标投影在最新 20 条内时，同款调用能找到（无截断时路径正常）', async () => {
    const { writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
    const projection = await loadProjection();
    const base = Date.parse('2026-09-30T00:00:00.000Z');
    const iso = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
    for (let i = 0; i < 19; i += 1) {
      await writeProjection(writeRecallJsonRecord, `proj-p6c${String(i).padStart(2, '0')}`, `turn-c-${i}`, iso(i));
    }
    await writeProjection(writeRecallJsonRecord, 'proj-p6ctarget', 'turn-c-target', iso(50));
    const clamped = await projection.listContextProjections(UID);
    expect(clamped.length).toBe(20);
    expect(clamped.filter((p) => p.taskRunId === 'turn-c-target').map((p) => p.id)).toEqual(['proj-p6ctarget']);
  });
});

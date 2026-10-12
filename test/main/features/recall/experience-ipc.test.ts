/**
 * specs/016 T009：`recall.experiences.*` 六条通道（契约 E1~E6）。
 *
 * 分两层验：
 *  - 读通道（E1/E2）只 mock experience-service 的读取——投影（列表零正文 /
 *    证据只回 kind/id/title / not found 语义）是 IPC 层的职责，mock 让载荷
 *    形状完全可控；
 *  - 写通道（E3~E6）走**真实** experience-service + tmpdir 夹具——终态拒绝、
 *    台账、合并去向这些行为只有真写盘才能钉住。
 *
 * 断言风格照 test/main/ipc/kstar-improvement-ipc.test.ts 的先例：协议层把
 * handler 抛错转成 ok:false，所以一律 `resolves.toMatchObject({ok:false})`，
 * 不用 rejects.toThrow。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uExperienceIpc';

// 只换读取（E1/E2 的数据源），写函数保持真实——工厂里 spread importOriginal。
const experienceReads = vi.hoisted(() => ({
  listExperiences: vi.fn(async () => [] as unknown[]),
  readExperience: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../../src/main/features/recall/experience-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/recall/experience-service')>()),
  listExperiences: experienceReads.listExperiences,
  readExperience: experienceReads.readExperience,
}));

// ⚠️ workspace 根必须**整文件固定**：src/main/paths.ts 的 WS_ROOT 是模块加载
// 时对 COGSEED_WORKSPACE_ROOT 的快照，而 vitest 的 mock 注册表会把
// importOriginal 拉进来的真实模块缓存跨用例复用——逐用例换 tmpdir 会让
// 缓存实例（旧根）与新实例（新根）错位，写出「experience not found」假象。
// 用例间隔离改用「每用例独立 user id + 用后删除该用户的目录树」。
const FILE_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-ipc-ws-'));
let activeUid = '';
let userSeq = 0;
let previousRoot: string | undefined;

beforeEach(async () => {
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = FILE_WORKSPACE;
  activeUid = `${UID}${++userSeq}`;
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  experienceReads.listExperiences.mockResolvedValue([]);
  experienceReads.readExperience.mockResolvedValue(undefined);
  vi.doMock('../../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../../src/main/features/users');
  users.activateUser(activeUid);
  (await import('../../../../src/main/ipc/index')).register();
});

afterEach(() => {
  vi.resetModules();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(path.join(FILE_WORKSPACE, activeUid), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(FILE_WORKSPACE, { recursive: true, force: true });
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('missing handler');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

/** 真实（未被 mock 的）experience-service：写通道的夹具与盘上回读都走它。 */
async function realService() {
  return vi.importActual<typeof import('../../../../src/main/features/recall/experience-service')>(
    '../../../../src/main/features/recall/experience-service',
  );
}

function fixtureInput(spec: { id: string; type?: 'lesson' | 'workflow' | 'gap' | 'uncategorized'; title?: string }) {
  const now = new Date().toISOString();
  const episodeId = `kse-${spec.id}`;
  return {
    id: spec.id,
    source: {
      episodeId,
      taskGoal: `任务-${spec.id}`,
      taskType: 'code' as const,
      taskStatus: 'confirmed',
    },
    experienceType: spec.type || 'lesson',
    title: spec.title || `经验-${spec.id}`,
    body: `正文-${spec.id}。IPC-SECRET-BODY`,
    scope: 'code',
    verification: {
      state: 'confirmed' as const,
      outcome: 'better_than_expected' as const,
      deltaR: 0.3,
      confidence: 0.8,
    },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${spec.id}` }],
    learningProvenance: {
      projectionId: `prj-${spec.id}`,
      episodeId,
      ruleRefs: [],
      attribution: 'execution_gap' as const,
    },
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedRealExperience(spec: { id: string; type?: 'lesson' | 'workflow' | 'gap' | 'uncategorized'; title?: string }) {
  const service = await realService();
  return service.createExperience(activeUid, fixtureInput(spec));
}

/** E1 mock 数据源用的完整记录形状（含正文与证据——用来验投影把它们剥掉）。 */
function rawRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'exp-raw-0001',
    title: '合并冲突的类型断言会掩盖运行时错误',
    body: '绝密正文 IPC-SECRET-BODY',
    experienceType: 'lesson',
    scope: 'code',
    source: { episodeId: 'kse-raw-1', taskGoal: '把 X 模块的测试补上', taskType: 'code', taskStatus: 'completed' },
    verification: { state: 'confirmed', outcome: 'worse_than_expected', deltaR: -0.4, confidence: 0.82 },
    evidenceRefs: [{ kind: 'conversation', id: 'conv-raw-1' }],
    learningProvenance: { projectionId: 'prj-raw-1', episodeId: 'kse-raw-1', ruleRefs: [], attribution: 'execution_gap' },
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

describe('ipc › recall.experiences.list (E1)', () => {
  it('默认只回 active；列表行零 body、零 evidenceRefs；形状符合契约', async () => {
    experienceReads.listExperiences.mockResolvedValue([
      rawRecord(),
      rawRecord({ id: 'exp-raw-0002', status: 'paused', updatedAt: '2026-09-24T10:00:00.000Z' }),
      rawRecord({ id: 'exp-raw-0003', status: 'archived', updatedAt: '2026-09-23T10:00:00.000Z' }),
    ] as never);
    const res = await call('recall.experiences.list');
    expect(res.ok).toBe(true);
    expect(res.total).toBe(1);
    expect(res.experiences).toHaveLength(1);
    expect(res.experiences![0]).toEqual({
      id: 'exp-raw-0001',
      title: '合并冲突的类型断言会掩盖运行时错误',
      experienceType: 'lesson',
      taskType: 'code',
      scope: 'code',
      outcome: 'worse_than_expected',
      verificationState: 'confirmed',
      status: 'active',
      sourceTask: { episodeId: 'kse-raw-1', goal: '把 X 模块的测试补上', taskStatus: 'completed' },
      updatedAt: '2026-09-25T10:00:00.000Z',
    });
    // 受限正文边界：整个响应序列化后都不含正文。
    expect(JSON.stringify(res)).not.toContain('IPC-SECRET-BODY');
  });

  it("status:'all' 给全量；type/taskType 过滤与 offset/limit 分页（total 不受分页影响）", async () => {
    experienceReads.listExperiences.mockResolvedValue([
      rawRecord(),
      rawRecord({ id: 'exp-raw-0002', status: 'paused', experienceType: 'gap', updatedAt: '2026-09-24T10:00:00.000Z' }),
      rawRecord({ id: 'exp-raw-0003', status: 'archived', updatedAt: '2026-09-23T10:00:00.000Z' }),
    ] as never);
    const all = await call('recall.experiences.list', { status: 'all' });
    expect(all.total).toBe(3);
    expect(all.experiences).toHaveLength(3);

    const filtered = await call('recall.experiences.list', { status: 'all', type: 'gap' });
    expect(filtered.total).toBe(1);
    expect(filtered.experiences![0].id).toBe('exp-raw-0002');

    const paged = await call('recall.experiences.list', { status: 'all', offset: 1, limit: 1 });
    expect(paged.total).toBe(3);
    expect(paged.experiences!.map((item: { id: string }) => item.id)).toEqual(['exp-raw-0002']);

    const byTaskType = await call('recall.experiences.list', { status: 'all', taskType: 'report' });
    expect(byTaskType.total).toBe(0);
  });

  it('非法入参全拒绝（枚举/offset/limit）且不透传到 feature 层', async () => {
    const badCalls: Array<Record<string, unknown>> = [
      { type: 'insight' },
      { taskType: 'ops' },
      { status: 'revoked' },
      { offset: -1 },
      { offset: 1.5 },
      { limit: 0 },
      { limit: 201 },
      { limit: 'many' },
    ];
    const expected = [
      'invalid recall experience type',
      'invalid recall experience task type',
      'invalid recall experience status',
      'invalid recall experience offset',
      'invalid recall experience offset',
      'invalid recall experience limit',
      'invalid recall experience limit',
      'invalid recall experience limit',
    ];
    for (let i = 0; i < badCalls.length; i += 1) {
      await expect(call('recall.experiences.list', badCalls[i])).resolves.toMatchObject({ ok: false, error: expected[i] });
    }
    expect(experienceReads.listExperiences).not.toHaveBeenCalled();
  });
});

describe('ipc › recall.experiences.read (E2)', () => {
  it('详情含正文与台账；evidenceRefs 只回 kind/id/title（无 excerpt/绝对路径）；mergedFrom 只回 id/title/mergedAt', async () => {
    experienceReads.readExperience.mockResolvedValue(rawRecord({
      expected: '预期结果',
      actual: '实际结果',
      applicableWhen: ['处理代码类任务时'],
      evidenceRefs: [{
        kind: 'conversation',
        id: 'conv-raw-1',
        title: '/Users/secret/对话记录.md',
        excerpt: '证据摘录不该外泄',
      }, {
        kind: 'artifact_file',
        id: 'file-raw-1',
        title: '迁移脚本.py',
        excerpt: '另一个摘录',
      }],
      mergedFrom: [{
        id: 'exp-raw-old',
        title: '旧经验',
        source: { episodeId: 'kse-old', taskGoal: '旧任务', taskType: 'code', taskStatus: 'completed' },
        evidenceRefs: [{ kind: 'conversation', id: 'conv-old' }],
        mergedAt: '2026-09-20T00:00:00.000Z',
      }],
      history: [{ at: '2026-09-24T00:00:00.000Z', actor: 'user', action: 'type_changed', from: 'gap', to: 'lesson', reason: '归类修正' }],
    }) as never);

    const res = await call('recall.experiences.read', { experienceId: 'exp-raw-0001' });
    expect(res.ok).toBe(true);
    const experience = res.experience as Record<string, unknown>;
    expect(experience.body).toBe('绝密正文 IPC-SECRET-BODY');
    expect(experience.expected).toBe('预期结果');
    expect(experience.applicableWhen).toEqual(['处理代码类任务时']);
    expect(experience.mergedIntoExperienceId).toBeNull();
    expect(experience.createdAt).toBe('2026-09-01T00:00:00.000Z');
    // 证据投影：第一个带绝对路径标题 → 标题被剥掉；第二个保留可读标题；excerpt 一律不回。
    expect(experience.evidenceRefs).toEqual([
      { kind: 'conversation', id: 'conv-raw-1' },
      { kind: 'artifact_file', id: 'file-raw-1', title: '迁移脚本.py' },
    ]);
    expect(JSON.stringify(res)).not.toContain('excerpt');
    expect(JSON.stringify(res)).not.toContain('证据摘录');
    expect(JSON.stringify(res)).not.toContain('/Users/secret');
    // 合并来源只回三字段：source/evidenceRefs 快照不随详情外溢。
    expect(experience.mergedFrom).toEqual([{ id: 'exp-raw-old', title: '旧经验', mergedAt: '2026-09-20T00:00:00.000Z' }]);
    expect(experience.history).toEqual([{ at: '2026-09-24T00:00:00.000Z', actor: 'user', action: 'type_changed', from: 'gap', to: 'lesson', reason: '归类修正' }]);
  });

  it('不存在 → ok:false 带 not found 语义；非法 id → invalid 且不透传', async () => {
    await expect(call('recall.experiences.read', { experienceId: 'exp-nope-404' })).resolves.toMatchObject({ ok: false, error: 'experience not found' });
    await expect(call('recall.experiences.read', { experienceId: 'not-an-id' })).resolves.toMatchObject({ ok: false, error: 'invalid recall experience id' });
    await expect(call('recall.experiences.read', {})).resolves.toMatchObject({ ok: false, error: 'invalid recall experience id' });
    // 非法 id 在协议层就被拦下，feature 层读取没被调用。
    expect(experienceReads.readExperience).toHaveBeenCalledTimes(1);
    expect(experienceReads.readExperience).toHaveBeenCalledWith(activeUid, 'exp-nope-404');
  });
});

describe('ipc › recall.experiences.setStatus (E3, 真实服务)', () => {
  it('pause→paused、resume→active，台账各一条；响应是列表形状（无 body）', async () => {
    await seedRealExperience({ id: 'exp-ipc-0001' });

    const paused = await call('recall.experiences.setStatus', { experienceId: 'exp-ipc-0001', action: 'pause', note: '先停用' });
    expect(paused.ok).toBe(true);
    expect(paused.experience).toMatchObject({ id: 'exp-ipc-0001', status: 'paused' });
    expect(paused.experience).not.toHaveProperty('body');

    const resumed = await call('recall.experiences.setStatus', { experienceId: 'exp-ipc-0001', action: 'resume' });
    expect(resumed.experience).toMatchObject({ status: 'active' });

    const service = await realService();
    const onDisk = await service.readExperience(activeUid, 'exp-ipc-0001');
    expect(onDisk?.status).toBe('active');
    expect(onDisk?.history).toHaveLength(2);
    expect(onDisk?.history![0]).toMatchObject({ actor: 'user', action: 'paused', from: 'active', to: 'paused', reason: '先停用' });
  });

  it('终态拒绝：归档后 setStatus 两次都是同一稳定错误', async () => {
    await seedRealExperience({ id: 'exp-ipc-0002' });
    await call('recall.experiences.archive', { experienceId: 'exp-ipc-0002', reason: '已过期' });

    const first = await call('recall.experiences.setStatus', { experienceId: 'exp-ipc-0002', action: 'pause' });
    const second = await call('recall.experiences.setStatus', { experienceId: 'exp-ipc-0002', action: 'resume' });
    expect(first).toMatchObject({ ok: false, error: 'archived experience is terminal and cannot be modified' });
    expect(second.error).toBe(first.error);
  });

  it('非法 action / 空 note / 超长 note 一律 invalid', async () => {
    await expect(call('recall.experiences.setStatus', { experienceId: 'exp-x', action: 'freeze' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience status action' });
    await expect(call('recall.experiences.setStatus', { experienceId: 'exp-ipc-ok', action: 'pause', note: '' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience status action' });
    await expect(call('recall.experiences.setStatus', { experienceId: 'exp-ipc-ok', action: 'pause', note: '长'.repeat(1_001) }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience status action' });
  });
});

describe('ipc › recall.experiences.setType (E4, 真实服务)', () => {
  it('类型往返 + 台账 from/to；uncategorized 是合法目标；其他字段不动', async () => {
    await seedRealExperience({ id: 'exp-ipc-0003', type: 'uncategorized' });

    const asGap = await call('recall.experiences.setType', { experienceId: 'exp-ipc-0003', experienceType: 'gap', note: '其实是缺口' });
    expect(asGap.experience).toMatchObject({ experienceType: 'gap' });
    const back = await call('recall.experiences.setType', { experienceId: 'exp-ipc-0003', experienceType: 'uncategorized' });
    expect(back.experience).toMatchObject({ experienceType: 'uncategorized' });

    const service = await realService();
    const onDisk = await service.readExperience(activeUid, 'exp-ipc-0003');
    expect(onDisk?.history!.map((entry) => `${entry.from}->${entry.to}`)).toEqual(['uncategorized->gap', 'gap->uncategorized']);
    expect(onDisk?.body).toBe(fixtureInput({ id: 'exp-ipc-0003' }).body);
    expect(onDisk?.scope).toBe('code');
  });

  it('非法类型与终态记录都拒绝（错误稳定）', async () => {
    await expect(call('recall.experiences.setType', { experienceId: 'exp-ipc-0004', experienceType: 'insight' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience type' });
    await seedRealExperience({ id: 'exp-ipc-0005' });
    await call('recall.experiences.archive', { experienceId: 'exp-ipc-0005', reason: '先归档' });
    await expect(call('recall.experiences.setType', { experienceId: 'exp-ipc-0005', experienceType: 'gap' }))
      .resolves.toMatchObject({ ok: false, error: 'archived experience is terminal and cannot be modified' });
  });
});

describe('ipc › recall.experiences.merge (E5, 真实服务)', () => {
  it('同类合并：回 target（含 mergedFrom）与 source 概要；盘上 source=merged+去向、target 有台账', async () => {
    await seedRealExperience({ id: 'exp-ipc-m1', title: '来源经验' });
    await seedRealExperience({ id: 'exp-ipc-m2' });

    const res = await call('recall.experiences.merge', { sourceExperienceId: 'exp-ipc-m1', targetExperienceId: 'exp-ipc-m2', note: '同两次沉淀' });
    expect(res.ok).toBe(true);
    expect(res.source).toEqual({ id: 'exp-ipc-m1', status: 'merged' });
    expect(res.experience).toMatchObject({ id: 'exp-ipc-m2', status: 'active' });
    expect((res.experience as Record<string, unknown>).mergedFrom).toEqual([
      { id: 'exp-ipc-m1', title: '来源经验', mergedAt: expect.any(String) as unknown as string },
    ]);
    expect(res.experience).not.toHaveProperty('body');

    const service = await realService();
    const source = await service.readExperience(activeUid, 'exp-ipc-m1');
    expect(source?.status).toBe('merged');
    expect(source?.mergedIntoExperienceId).toBe('exp-ipc-m2');
    expect(source?.body).toContain('IPC-SECRET-BODY'); // 不物理删除
    const target = await service.readExperience(activeUid, 'exp-ipc-m2');
    expect(target?.mergedFrom![0]).toMatchObject({ id: 'exp-ipc-m1', source: expect.anything() as never, evidenceRefs: expect.anything() as never });
    expect(target?.history![0]).toMatchObject({ actor: 'user', action: 'merged_from', from: 'exp-ipc-m1', reason: '同两次沉淀' });
  });

  it('跨类型拒绝、重复合并拒绝、非法入参拒绝（错误稳定）', async () => {
    await seedRealExperience({ id: 'exp-ipc-m3', type: 'lesson' });
    await seedRealExperience({ id: 'exp-ipc-m4', type: 'gap' });
    await expect(call('recall.experiences.merge', { sourceExperienceId: 'exp-ipc-m3', targetExperienceId: 'exp-ipc-m4' }))
      .resolves.toMatchObject({ ok: false, error: 'experience merge requires the same experienceType' });

    await seedRealExperience({ id: 'exp-ipc-m5' });
    await call('recall.experiences.merge', { sourceExperienceId: 'exp-ipc-m3', targetExperienceId: 'exp-ipc-m5' });
    await expect(call('recall.experiences.merge', { sourceExperienceId: 'exp-ipc-m3', targetExperienceId: 'exp-ipc-m5' }))
      .resolves.toMatchObject({ ok: false, error: 'experience has already been merged into exp-ipc-m5' });

    await expect(call('recall.experiences.merge', { sourceExperienceId: 'bad id', targetExperienceId: 'exp-ipc-m5' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience merge' });
    await expect(call('recall.experiences.merge', { sourceExperienceId: 'exp-ipc-m4', targetExperienceId: 'exp-ipc-m4', note: 'x'.repeat(1_001) }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience merge' });
  });
});

describe('ipc › recall.experiences.archive (E6, 真实服务)', () => {
  it('缺/空/超长 reason 一律 invalid 且不落库；归档成功后默认列表零出现、status:all 可见', async () => {
    await seedRealExperience({ id: 'exp-ipc-a1' });

    await expect(call('recall.experiences.archive', { experienceId: 'exp-ipc-a1' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience archive' });
    await expect(call('recall.experiences.archive', { experienceId: 'exp-ipc-a1', reason: '  ' }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience archive' });
    await expect(call('recall.experiences.archive', { experienceId: 'exp-ipc-a1', reason: '因'.repeat(1_001) }))
      .resolves.toMatchObject({ ok: false, error: 'invalid recall experience archive' });
    const service = await realService();
    const untouched = await service.readExperience(activeUid, 'exp-ipc-a1');
    expect(untouched?.status).toBe('active');
    expect(untouched?.archivedAt).toBeUndefined();

    const archived = await call('recall.experiences.archive', { experienceId: 'exp-ipc-a1', reason: '已过期不再适用' });
    expect(archived.experience).toMatchObject({ id: 'exp-ipc-a1', status: 'archived' });
    const onDisk = await service.readExperience(activeUid, 'exp-ipc-a1');
    expect(onDisk?.archivedAt).toEqual(expect.any(String) as unknown as string);
    expect(onDisk?.archiveReason).toBe('已过期不再适用');
    expect(onDisk?.history!.at(-1)).toMatchObject({ action: 'archived', reason: '已过期不再适用' });

    // 归档后默认清单零出现（status 缺省 active），'all' 才可见——这里把 mock
    // 读接回真实盘上状态，验证整条链路。
    experienceReads.listExperiences.mockImplementation(async () => service.listExperiences(activeUid) as never);
    const activeOnly = await call('recall.experiences.list');
    expect(activeOnly.total).toBe(0);
    expect(JSON.stringify(activeOnly)).not.toContain('exp-ipc-a1');
    const all = await call('recall.experiences.list', { status: 'all' });
    expect(all.total).toBe(1);
    expect(all.experiences![0]).toMatchObject({ id: 'exp-ipc-a1', status: 'archived' });
  });
});

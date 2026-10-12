/**
 * specs/016 T022 / 契约 E9~E10 / data-model §6：经验集引用（@ 历史任务带入）。
 *
 * 五条主断言（先写先红）：
 *  ① @ 带入成功 → conversation.task_references 出现 kind:'experience_set' 且含快照
 *     （version/title/body/experienceType/taskType，正文按单条上限截断）；
 *  ② 部分被拦 → 通过者写入、被拦者逐条回规则名（code + rule + 标题可见、正文不可见）；
 *  ③ 全被拦 → ok:false（experience_attach_blocked）且不写半截引用（既有引用不受影响）；
 *  ④ _mergeTaskReferences **不**合并该 kind：发送时快照正文不进 model_text——
 *     经验内容只由经验清单构建器带入，task_references 里再合一遍就是双注入
 *     （data-model §6 不变量）；
 *  ⑤ 撤销（既有 conversations.taskRefs.remove）后挂载集为空 → 下一轮不再带入。
 *
 * 另覆盖 E9 sourceTasks（只列有经验的来源任务、query/limit、无经验 → 空数组）与
 * E10 omissions（未挂载 → 空数组；被拦回执只回标题与规则码、无正文）。
 *
 * 断言风格照 test/main/features/recall/experience-ipc.test.ts（协议层 ok:false，
 * workspace 根整文件固定 + 每用例独立 uid）与
 * test/main/features/group_chat/task-reference-merge.test.ts（send 全链路 mock 模型）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uExperienceRef';

// 断言④要跑 groupChat.send 全链路：模型客户端必须 mock（否则真发请求）。
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'cogseed.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));

// ⚠️ workspace 根必须**整文件固定**（experience-ipc.test.ts 的教训：模块缓存的
// WS_ROOT 是加载时快照，逐用例换 tmpdir 会让缓存实例与新实例错位）。用例间隔离
// 改用「每用例独立 user id + 用后删除该用户的目录树」。
const FILE_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-experience-ref-ws-'));
let activeUid = '';
let userSeq = 0;
let previousRoot: string | undefined;
const createdCids: string[] = [];

beforeEach(async () => {
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = FILE_WORKSPACE;
  activeUid = `${UID}${++userSeq}`;
  invokeHandler = null;
  vi.resetModules();
  vi.doMock('../../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../../src/main/features/users');
  users.activateUser(activeUid);
  (await import('../../../../src/main/ipc/index')).register();
});

afterEach(async () => {
  // bus 清理必须发生在下一轮 vi.resetModules 之前：这里 import 到的还是本用例的
  // 模块实例（与 task-reference-merge.test.ts 同款顺序）。
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of createdCids) {
      await bus.abort(activeUid, cid);
      await bus.dropConv(activeUid, cid);
    }
  } catch (_) {}
  createdCids.length = 0;
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot === undefined ? process.env.COGSEED_WORKSPACE_ROOT : previousRoot;
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  fs.rmSync(path.join(FILE_WORKSPACE, activeUid), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(FILE_WORKSPACE, { recursive: true, force: true });
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('missing handler');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

interface SeedSpec {
  id: string;
  episodeId: string;
  taskGoal?: string;
  status?: 'active' | 'paused';
  body?: string;
  updatedAt?: string;
}

async function seedExperience(spec: SeedSpec) {
  const service = await import('../../../../src/main/features/recall/experience-service');
  const now = spec.updatedAt || new Date().toISOString();
  return service.createExperience(activeUid, {
    id: spec.id,
    source: {
      episodeId: spec.episodeId,
      taskGoal: spec.taskGoal || `任务-goal-${spec.episodeId}`,
      taskType: 'code',
      taskStatus: 'confirmed',
    },
    experienceType: 'lesson',
    title: `经验-${spec.id}`,
    body: spec.body || `正文-${spec.id}。REF-SECRET-${spec.id}`,
    scope: 'code',
    verification: { state: 'confirmed' as const, outcome: 'better_than_expected' as const, deltaR: 0.3, confidence: 0.8 },
    evidenceRefs: [{ kind: 'conversation' as const, id: `conv-${spec.id}` }],
    learningProvenance: { projectionId: `prj-${spec.id}`, episodeId: spec.episodeId, ruleRefs: [], attribution: 'execution_gap' as const },
    status: spec.status || 'active' as const,
    createdAt: now,
    updatedAt: now,
  });
}

async function createConv(cid: string) {
  const chats = await import('../../../../src/main/features/chats');
  const conv = await chats.createConversation(activeUid, { conversationId: cid, title: `Conv-${cid}` });
  createdCids.push(cid);
  return conv;
}

/** 读回会话上的 experience_set 引用（挂载集的唯一事实来源）。 */
async function readExperienceSetRef(cid: string) {
  const chats = await import('../../../../src/main/features/chats');
  const conv = await chats.getConversation(activeUid, cid);
  return ((conv?.task_references || []).find((r) => (r as { kind?: string }).kind === 'experience_set') || null) as {
    kind: string; name: string; episode_id?: string;
    experienceIds?: string[];
    snapshots?: Record<string, { version: string; title: string; body: string; experienceType: string; taskType: string }>;
    addedAt?: string;
  } | null;
}

describe('experience set reference · attach (T022 ①②③⑤)', () => {
  it('① 带入成功：task_references 出现 kind:experience_set 且快照冻结（长正文按单条上限截断）', async () => {
    await seedExperience({ id: 'exp-ref-a1', episodeId: 'kse-ref-ep1', updatedAt: '2026-09-24T10:00:00.000Z' });
    await seedExperience({
      id: 'exp-ref-long', episodeId: 'kse-ref-ep1', updatedAt: '2026-09-25T10:00:00.000Z',
      body: `甲`.repeat(3_000) + 'LONG-REF-SECRET',
    });
    await createConv('conv-ref-ok');

    const res = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-ok', episodeId: 'kse-ref-ep1' });
    expect(res.ok).toBe(true);
    expect(res.attached).toMatchObject({
      referenceKey: 'experience_set:kse-ref-ep1',
      experienceIds: ['exp-ref-long', 'exp-ref-a1'], // updatedAt 降序
      available: ['exp-ref-long', 'exp-ref-a1'],
      blocked: [],
    });

    const setRef = await readExperienceSetRef('conv-ref-ok');
    expect(setRef).toBeTruthy();
    if (!setRef) return;
    expect(setRef.episode_id).toBe('kse-ref-ep1');
    // chip 名用任务目标（可读），不裸出 episode id。
    expect(setRef.name).toContain('任务-goal-kse-ref-ep1');
    expect(setRef.experienceIds).toEqual(['exp-ref-long', 'exp-ref-a1']);
    expect(setRef.addedAt).toEqual(expect.any(String) as unknown as string);
    // 快照冻结：version=updatedAt、正文/标题/类型全量在（改/删原条目后仍可读）。
    expect(setRef.snapshots?.['exp-ref-a1']).toEqual({
      version: '2026-09-24T10:00:00.000Z',
      title: '经验-exp-ref-a1',
      body: '正文-exp-ref-a1。REF-SECRET-exp-ref-a1',
      experienceType: 'lesson',
      taskType: 'code',
    });
    // 长正文按单条上限截断（与 read_task_experience 的 ≤2000 分批同口径）。
    expect(setRef.snapshots?.['exp-ref-long'].body).toHaveLength(2_000);
  });

  it('② 部分被拦：通过者写入，被拦者逐条回规则名（标题可见、正文不可见）', async () => {
    await seedExperience({ id: 'exp-ref-p1', episodeId: 'kse-ref-part' });
    await seedExperience({ id: 'exp-ref-p2', episodeId: 'kse-ref-part', status: 'paused' });
    await createConv('conv-ref-part');

    const res = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-part', episodeId: 'kse-ref-part' });
    expect(res.ok).toBe(true);
    expect(res.attached).toMatchObject({
      referenceKey: 'experience_set:kse-ref-part',
      experienceIds: ['exp-ref-p1'],
      available: ['exp-ref-p1'],
    });
    expect(res.attached?.blocked).toEqual([
      { experienceId: 'exp-ref-p2', title: '经验-exp-ref-p2', code: 'status_not_active', rule: 'paused' },
    ]);

    const setRef = await readExperienceSetRef('conv-ref-part');
    expect(setRef?.experienceIds).toEqual(['exp-ref-p1']);
    expect(Object.keys(setRef?.snapshots || {})).toEqual(['exp-ref-p1']);
    // 被拦条目的正文不得随载荷外泄（受限正文边界）。
    expect(JSON.stringify(res)).not.toContain('REF-SECRET-exp-ref-p2');
  });

  it('③ 全被拦：ok:false + experience_attach_blocked，不写半截引用（既有引用不受影响）', async () => {
    await seedExperience({ id: 'exp-ref-q1', episodeId: 'kse-ref-allpaused', status: 'paused' });
    await seedExperience({ id: 'exp-ref-q2', episodeId: 'kse-ref-allpaused', status: 'paused' });
    await createConv('conv-ref-src');
    await createConv('conv-ref-none');
    // 既有引用（产物）必须原样保留——被拦不等于顺手清场。
    await call('conversations.taskRefs.add', {
      cid: 'conv-ref-none',
      reference: { kind: 'artifact', name: '报告.docx', source_cid: 'conv-ref-src', file_name: '报告.docx' },
    });

    const res = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-none', episodeId: 'kse-ref-allpaused' });
    expect(res).toMatchObject({ ok: false, code: 'experience_attach_blocked' });
    expect(res.blocked).toHaveLength(2);
    for (const item of res.blocked as Array<{ code: string; rule: string }>) {
      expect(item.code).toBe('status_not_active');
      expect(item.rule).toBe('paused');
    }

    const chats = await import('../../../../src/main/features/chats');
    const conv = await chats.getConversation(activeUid, 'conv-ref-none');
    const kinds = (conv?.task_references || []).map((r) => r.kind);
    expect(kinds).not.toContain('experience_set');
    expect(kinds).toEqual(['artifact']);
  });

  it('⑤ 撤销（既有 taskRefs.remove）后挂载集为空，下一轮不再带入', async () => {
    await seedExperience({ id: 'exp-ref-r1', episodeId: 'kse-ref-revoke' });
    await createConv('conv-ref-revoke');

    const attach = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-revoke', episodeId: 'kse-ref-revoke' });
    expect(attach.ok).toBe(true);

    const listed = await call('conversations.taskRefs.list', { cid: 'conv-ref-revoke' });
    const refs = (listed.references || []) as Array<{ kind: string }>;
    const index = refs.findIndex((r) => r.kind === 'experience_set');
    expect(index).toBeGreaterThanOrEqual(0);

    const removed = await call('conversations.taskRefs.remove', { cid: 'conv-ref-revoke', index });
    expect(removed.ok).toBe(true);

    // 撤销 = 移除引用：挂载集为空 → 下一轮清单构建的 mounted 无来源、omissions 无记录。
    expect(await readExperienceSetRef('conv-ref-revoke')).toBeNull();
    const omissions = await call('recall.experiences.omissions', { cid: 'conv-ref-revoke' });
    expect(omissions.ok).toBe(true);
    expect(omissions.omissions).toEqual([]);
  });
});

describe('experience set reference · send merge guard (T022 ④)', () => {
  it('发送时 experience_set 快照不进 model_text（_mergeTaskReferences 不合并该 kind）', async () => {
    await seedExperience({ id: 'exp-ref-m1', episodeId: 'kse-ref-merge' });
    await createConv('conv-ref-merge');

    const attach = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-merge', episodeId: 'kse-ref-merge' });
    expect(attach.ok).toBe(true);

    const groupChat = await import('../../../../src/main/features/group_chat');
    const result = await groupChat.send({ userId: activeUid, cid: 'conv-ref-merge', text: '请按经验处理' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 快照正文绝不进模型文本；也不出现资产同款的上下文块标记（那是 kind:'asset' 的路）。
    expect(result.msg?.model_text || '').not.toContain('REF-SECRET-exp-ref-m1');
    expect(result.msg?.model_text || '').not.toContain('【本任务引用的空间资产】');
    expect(result.msg?.text).toBe('请按经验处理');
  });
});

describe('ipc › recall.experiences.sourceTasks (E9)', () => {
  it('无经验的用户返回空数组', async () => {
    const res = await call('recall.experiences.sourceTasks');
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([]);
  });

  it('只列有经验的来源任务（episode 维度）：字段形状、query 过滤、limit 截断', async () => {
    await seedExperience({ id: 'exp-ref-s1', episodeId: 'kse-ref-epa', updatedAt: '2026-09-24T10:00:00.000Z' });
    await seedExperience({ id: 'exp-ref-s2', episodeId: 'kse-ref-epa', status: 'paused', updatedAt: '2026-09-23T10:00:00.000Z' });
    await seedExperience({ id: 'exp-ref-s3', episodeId: 'kse-ref-epb', taskGoal: '写季度总结报告', updatedAt: '2026-09-22T10:00:00.000Z' });

    const res = await call('recall.experiences.sourceTasks');
    expect(res.ok).toBe(true);
    const tasks = res.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2); // 没有经验的 episode（无种子）不出现
    // updatedAt 降序：epa（最新 09-24）在前。
    expect(tasks[0]).toMatchObject({
      episodeId: 'kse-ref-epa',
      goal: '任务-goal-kse-ref-epa',
      taskType: 'code',
      taskStatus: 'confirmed',
      experienceCount: 2,
      activeCount: 1,
      updatedAt: '2026-09-24T10:00:00.000Z',
    });
    expect(tasks[1]).toMatchObject({ episodeId: 'kse-ref-epb', experienceCount: 1, activeCount: 1 });

    const filtered = await call('recall.experiences.sourceTasks', { query: '季度总结' });
    expect((filtered.tasks as Array<{ episodeId: string }>).map((t) => t.episodeId)).toEqual(['kse-ref-epb']);

    const limited = await call('recall.experiences.sourceTasks', { limit: 1 });
    expect(limited.tasks).toHaveLength(1);

    // 载荷不含正文（目录行边界）。
    expect(JSON.stringify(res)).not.toContain('REF-SECRET');
  });

  it('非法入参拒绝（limit 范围 / query 类型）', async () => {
    await expect(call('recall.experiences.sourceTasks', { limit: 0 })).resolves.toMatchObject({ ok: false, error: 'invalid recall experience source task limit' });
    await expect(call('recall.experiences.sourceTasks', { limit: 101 })).resolves.toMatchObject({ ok: false, error: 'invalid recall experience source task limit' });
    await expect(call('recall.experiences.sourceTasks', { query: 123 })).resolves.toMatchObject({ ok: false, error: 'invalid recall experience source task query' });
  });
});

describe('ipc › recall.experiences.omissions (E10)', () => {
  it('未挂载经验集的会话返回空数组', async () => {
    await createConv('conv-ref-om-empty');
    const res = await call('recall.experiences.omissions', { cid: 'conv-ref-om-empty' });
    expect(res.ok).toBe(true);
    expect(res.omissions).toEqual([]);
  });

  it('已挂载但下一轮被拦：只回标题与规则码（无正文），limit 生效', async () => {
    await seedExperience({ id: 'exp-ref-o1', episodeId: 'kse-ref-om', body: '挂载后被暂停的经验正文 REF-OM-SECRET-O1' });
    await seedExperience({ id: 'exp-ref-o2', episodeId: 'kse-ref-om2', body: '挂载后被暂停的经验正文 REF-OM-SECRET-O2', updatedAt: '2026-09-23T10:00:00.000Z' });
    await createConv('conv-ref-om');

    const attach1 = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-om', episodeId: 'kse-ref-om' });
    expect(attach1.ok).toBe(true);
    const attach2 = await call('recall.experiences.attachToTask', { conversationId: 'conv-ref-om', episodeId: 'kse-ref-om2' });
    expect(attach2.ok).toBe(true);

    // 挂载之后两条都被暂停（E3 的开关面「准入立即生效」）。
    await call('recall.experiences.setStatus', { experienceId: 'exp-ref-o1', action: 'pause' });
    await call('recall.experiences.setStatus', { experienceId: 'exp-ref-o2', action: 'pause' });

    // 模拟「下一轮」清单构建：装配点把挂载集传给 hint（omitted 回执在此产生）。
    const hint = await import('../../../../src/main/features/recall/experience-catalog-hint');
    const setRefs = await (async () => {
      const chats = await import('../../../../src/main/features/chats');
      const conv = await chats.getConversation(activeUid, 'conv-ref-om');
      return (conv?.task_references || []).filter((r) => (r as { kind?: string }).kind === 'experience_set') as Array<{ experienceIds?: string[] }>;
    })();
    const mountedIds = setRefs.flatMap((r) => r.experienceIds || []);
    expect(mountedIds.sort()).toEqual(['exp-ref-o1', 'exp-ref-o2']);
    await hint.experienceCatalogForPrompt(activeUid, 'conv-ref-om', Date.now(), '修复登录函数', {
      taskRunId: 'turn-ref-om-1',
      experienceIds: mountedIds,
    });

    const res = await call('recall.experiences.omissions', { cid: 'conv-ref-om' });
    expect(res.ok).toBe(true);
    const omissions = res.omissions as Array<Record<string, unknown>>;
    expect(omissions).toHaveLength(2);
    for (const item of omissions) {
      expect(item).toMatchObject({ reason: 'status_not_active', stage: 'experience_hint' });
      expect(item.createdAt).toEqual(expect.any(String) as unknown as string);
      expect('body' in item).toBe(false);
    }
    expect(omissions.map((item) => item.experienceId).sort()).toEqual(['exp-ref-o1', 'exp-ref-o2']);
    // 标题可见（界面要说清是哪条），正文不可见。
    expect(JSON.stringify(res)).toContain('经验-exp-ref-o1');
    expect(JSON.stringify(res)).not.toContain('REF-OM-SECRET');

    const limited = await call('recall.experiences.omissions', { cid: 'conv-ref-om', limit: 1 });
    expect(limited.omissions).toHaveLength(1);
  });
});

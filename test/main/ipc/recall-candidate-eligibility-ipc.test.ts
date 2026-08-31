/**
 * 候选「可确认」契约在**真实 IPC 读口**上的回归护栏。
 *
 * `test/main/features/recall/candidate-eligibility-contract.test.ts` 已经在
 * service 层守住了同一批不变量，但那一层看不到
 * 渲染层真正拿到的东西：能力判据是 `recall.candidates.list` 的 handler 现算
 * 现拼的 DTO 投影，「待我处理」是 `cognition.inbox.list` 的服务端读模型。
 * 两个 handler body 此前没有任何 IPC 级用例穿过——`test/main/ipc/recall.test.ts`
 * 与 `test/main/ipc/cognition-ipc.test.ts` 都把 feature 层整份 mock 掉了，
 * 断言的是 mock 的返回值，验不了「真实落库 → 真实读口」这一段。
 *
 * 所以这份文件刻意**不 mock feature 层**：只保留 electron / logger /
 * kb_embed（伪 embedding，避免真实向量模型）/ local_agents（置空）这四个
 * 载入期必需的替身，候选服务、能力判据、inbox 适配器全部走真实实现，
 * 存储落在临时目录里。
 *
 * 守的产品不变量（回归历史见 docs/recall-candidate-promotion-audit.md）：
 *   **列表说"能确认"的候选，promote 必须真的成功；列表说"不能确认"的候选，
 *   「待我处理」不得把它出成普通待办，绕过 UI 直接 promote 也必须被拒。**
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeResult = { ok: boolean; error?: string } & Record<string, unknown>;
type InvokeFn = (event: unknown, req: { channel: string; payload?: unknown }) => Promise<InvokeResult>;

type CandidateCapabilities = {
  canPromote: boolean;
  canConfirm: boolean;
  canBatchSelect: boolean;
  eligibility: string;
  ineligibleReasons: string[];
};
type CandidateDto = { id: string; status: string; capabilities: CandidateCapabilities };
type InboxItem = { id: string; kind: string; candidateId?: string; detail?: string };

let invokeHandler: InvokeFn | null = null;
let tmpDir = '';
let previousRoot: string | undefined;
const UID = 'uRecallEligibilityIpc';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'cogseed.invoke') invokeHandler = fn;
    },
    on: vi.fn(),
  },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

// 语义查重要跑 embedding：用确定性哈希向量顶替，既避免加载真实模型，
// 也让同一段文本在同一次运行里恒等（查重路径本身仍走真实实现）。
vi.mock('../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

/** 项目事实伪装成 personal —— PRD 3.4 明确排除，classification 阻断。 */
const PROJECT_FACT = {
  judgment: '我今天在修 KSTAR 的候选池',
  summary: '当前任务',
  value: '记录当前进度',
  suggestedType: 'personal',
  suggestedScope: 'project',
  suggestedAction: 'create',
};

/** 真正的长期偏好 —— 过闸。 */
const DURABLE_PREFERENCE = {
  judgment: '我长期更喜欢先看整体结构再看细节',
  summary: '结构优先',
  value: '后续任务先给结构再展开，可以少一轮返工',
  suggestedType: 'personal',
  suggestedScope: 'global',
  suggestedAction: 'create',
};

const REFS = [{ kind: 'conversation', id: 'conv-1' }];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-eligibility-ipc-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  // local_agents 的 handler 表与本用例无关，置空避免拉起 agent 运行时。
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): Promise<InvokeResult> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

/** 真实候选服务（未 mock）——用于把候选真的写进临时工作区，再从 IPC 读回来。 */
const candidateService = () => import('../../../src/main/features/recall/candidate-service');

async function listCandidates(): Promise<CandidateDto[]> {
  const result = await call('recall.candidates.list');
  expect(result.ok).toBe(true);
  return result.candidates as CandidateDto[];
}

async function listInbox(): Promise<InboxItem[]> {
  const result = await call('cognition.inbox.list');
  expect(result.ok).toBe(true);
  expect(result.total).toBe((result.items as InboxItem[]).length);
  return result.items as InboxItem[];
}

const findById = (candidates: CandidateDto[], id: string): CandidateDto => {
  const found = candidates.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`candidate ${id} missing from recall.candidates.list`);
  return found;
};

describe('候选可确认性在真实 IPC 读口上闭环', () => {
  it('Case A 合格候选：list 说能确认 → inbox 出普通待办 → promote 真的落出正式资产', async () => {
    const candidates = await candidateService();
    const saved = await candidates.saveRecallCandidate(UID, {
      ...DURABLE_PREFERENCE, sourceRefs: REFS, evidenceRefs: REFS,
    } as never);
    expect(saved.status).toBe('pending_review');

    const dto = findById(await listCandidates(), saved.id);
    expect(dto.capabilities.canPromote).toBe(true);
    expect(dto.capabilities.canConfirm).toBe(true);
    expect(dto.capabilities.eligibility).toBe('eligible');

    const inboxItem = (await listInbox()).find((item) => item.candidateId === saved.id);
    expect(inboxItem?.kind).toBe('candidate_pending_review');

    const promoted = await call('recall.candidates.promote', { candidateId: saved.id });
    expect(promoted.ok).toBe(true);
    const candidate = promoted.candidate as { status: string; promotedAssetId?: string };
    const asset = promoted.asset as { id: string; type: string };
    expect(candidate.status).toBe('confirmed');
    // 真的落出了一条正式资产，不是只把候选标成 confirmed。
    expect(candidate.promotedAssetId).toBeTruthy();
    expect(asset.id).toBe(candidate.promotedAssetId);
    expect(asset.type).toBe('personal');
  });

  it('Case B 不合格候选：list 标 ineligible → inbox 出 candidate_ineligible → 绕过 UI 的 promote 仍被拒', async () => {
    const candidates = await candidateService();
    const saved = await candidates.saveRecallCandidate(UID, {
      ...PROJECT_FACT, sourceRefs: REFS, evidenceRefs: REFS, forceWeakObservation: true,
    } as never);
    expect(saved.status).toBe('weak_observation');

    const dto = findById(await listCandidates(), saved.id);
    expect(dto.capabilities.eligibility).toBe('ineligible');
    expect(dto.capabilities.ineligibleReasons).toContain('personal_is_project_fact');
    expect(dto.capabilities.canPromote).toBe(false);
    expect(dto.capabilities.canConfirm).toBe(false);
    expect(dto.capabilities.canBatchSelect).toBe(false);

    // 「待我处理」必须把它出成 candidate_ineligible 并保留阻断原因，
    // 而不是伪装成普通待确认候选骗用户认真审批一次。
    const inbox = await listInbox();
    const item = inbox.find((entry) => entry.candidateId === saved.id);
    expect(item?.kind).toBe('candidate_ineligible');
    expect(item?.detail).toBe('personal_is_project_fact');
    expect(inbox.map((entry) => entry.kind)).not.toContain('candidate_pending_review');

    // 最后一道防线：即使渲染层不看 capabilities 直接调 promote，后端也要拒。
    const promoted = await call('recall.candidates.promote', { candidateId: saved.id });
    expect(promoted.ok).toBe(false);
    expect(promoted.code).toBe('promotion_blocked');
    expect(promoted.promotionReasons).toContain('personal_is_project_fact');
  });

  it('Case C 跨候选冲突：list 真的跑了 recallCandidateConflictingTypes，不是只做单条投影', async () => {
    // 冲突是**跨候选**判断，单条候选算不出来——只有持有全量列表的读口能算。
    // handler 里少传 conflicts 的话，列表会说"能确认"，而晋升闸门按同一批
    // 数据判冲突并拒绝，又是一次假审批。同一句话被分成两类即构成冲突。
    const candidates = await candidateService();
    const asPersonal = await candidates.saveRecallCandidate(UID, {
      ...DURABLE_PREFERENCE, sourceRefs: REFS, evidenceRefs: REFS,
    } as never);
    const asRule = await candidates.saveRecallCandidate(UID, {
      ...DURABLE_PREFERENCE,
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'conversation', id: 'conv-2' }],
      evidenceRefs: [{ kind: 'conversation', id: 'conv-2' }],
    } as never);

    const listed = await listCandidates();
    for (const id of [asPersonal.id, asRule.id]) {
      const dto = findById(listed, id);
      expect(dto.capabilities.eligibility).toBe('ineligible');
      expect(dto.capabilities.ineligibleReasons).toContain('type_conflicts_with_existing');
      expect(dto.capabilities.canPromote).toBe(false);
    }

    // 列表与晋升闸门用的是同一套判据：列表说不能确认，promote 也必须拒。
    const promoted = await call('recall.candidates.promote', { candidateId: asPersonal.id });
    expect(promoted.ok).toBe(false);
    expect(promoted.code).toBe('promotion_blocked');
  });
});

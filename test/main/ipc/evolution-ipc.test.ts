import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
const TEST_UID = 'uEvolutionIpc';

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = fn;
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

vi.mock('../../../src/main/features/evolution', () => ({
  buildDashboard: vi.fn(async (_uid: string) => ({ skillCount: 1, enabledSkillCount: 1, pendingReviewCount: 0, evolutionRunCount: 0, runningEvolutionCount: 0, degraded: false })),
  startEvolutionRun: vi.fn(async (_uid: string, input: any) => ({ runId: 'r1', skillId: input.skillId, steps: [] })),
  stepEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId, steps: [] })),
  abortEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId, status: 'aborted' })),
  readEvolutionRun: vi.fn(async (_uid: string, runId: string) => ({ runId })),
  listEvolutionRuns: vi.fn(async () => ([{ runId: 'r1' }])),
  readEvalRecord: vi.fn(async (_uid: string, skillId: string) => ({ skillId, cases: [], runs: [] })),
  upsertEvalCase: vi.fn(async (_uid: string, skillId: string) => ({ skillId, cases: [{ id: 1 }], runs: [] })),
  extractAndSaveOntology: vi.fn(async () => ({ slice: { tbox: [], rbox: [], abox: [] }, degraded: false })),
  listSkillOntologies: vi.fn(async () => ([])),
  listSkillVersions: vi.fn(async () => ([{ version: '0.1.1', at: 't' }])),
  exportSkillZip: vi.fn(async (_uid: string, skillId: string) => ({ ok: true, zipPath: `/tmp/${skillId}-v0.2.0.zip` })),
  captureSkillIntent: vi.fn(async (_uid: string, input: any) => ({ skill_id: 'skill_x', intent: { purpose: input.purpose }, questions: ['q1'] })),
  createSkillFromDraft: vi.fn(async (_uid: string, input: any) => ({ skill: { id: 'sk-new', name: input.name } })),
  recommendForSkill: vi.fn(async (_uid: string, skillId: string) => ({ skillId, suggestions: [{ id: 's1', ontology: '学术规范', rule: 'R1', description: 'd', severity: 'warning', suggestion: '加规则', selected: false }] })),
  listOntologyBindings: vi.fn(async () => (['onto-a'])),
  bindOntology: vi.fn(async (_uid: string, _skillId: string, ontologyId: string) => (['onto-a', ontologyId])),
  unbindOntology: vi.fn(async () => ([])),
  applyPatchToSkill: vi.fn(async (_uid: string, input: any) => ({ ok: true, newVersion: '0.1.1', skillId: input.skillId })),
}));

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}) {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('ipc › evolution channels', () => {
  it('evolution.dashboard 转发并返回聚合', async () => {
    const r = await call('evolution.dashboard');
    expect(r.ok).toBe(true);
    expect(r.skillCount).toBe(1);
  });
  it('evolution.evolve.start 校验 skillId 缺失时 ok:false', async () => {
    const r = await call('evolution.evolve.start', {});
    expect(r.ok).toBe(false);
  });
  it('evolution.evolve.step 转发 runId', async () => {
    const r = await call('evolution.evolve.step', { runId: 'r1' });
    expect(r.ok).toBe(true);
    expect(r.runId).toBe('r1');
  });
  it('evolution.evolve.recommend 返回建议列表', async () => {
    const r = await call('evolution.evolve.recommend', { skillId: 'sk1' });
    expect(r.ok).toBe(true);
    expect(r.suggestions[0].rule).toBe('R1');
  });
  it('evolution.evolve.recommend 缺 skillId 时 ok:false', async () => {
    const r = await call('evolution.evolve.recommend', {});
    expect(r.ok).toBe(false);
  });
  it('evolution.ontology.extract 返回 degraded 标记', async () => {
    const r = await call('evolution.ontology.extract', { skillId: 'sk1', text: 't' });
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
  });
  it('evolution.patches.apply 缺 newContent 时 ok:false', async () => {
    const r = await call('evolution.patches.apply', { skillId: 'sk1' });
    expect(r.ok).toBe(false);
  });
  it('evolution.skills.versions 返回 versions', async () => {
    const r = await call('evolution.skills.versions', { skillId: 'sk1' });
    expect(r.ok).toBe(true);
    expect(r.versions[0].version).toBe('0.1.1');
  });
  it('evolution.skills.export 返回 zipPath', async () => {
    const r = await call('evolution.skills.export', { skillId: 'sk1', version: '0.2.0' });
    expect(r.ok).toBe(true);
    expect(r.zipPath).toContain('sk1-v0.2.0.zip');
  });
  it('evolution.skills.captureIntent 缺 purpose 时 ok:false', async () => {
    const r = await call('evolution.skills.captureIntent', { name: 'x' });
    expect(r.ok).toBe(false);
  });
  it('evolution.skills.captureIntent 返回意图+问题', async () => {
    const r = await call('evolution.skills.captureIntent', { name: 'x', purpose: '目的' });
    expect(r.ok).toBe(true);
    expect(r.questions).toContain('q1');
  });
  it('evolution.skills.createDraft 缺 name 时 ok:false', async () => {
    const r = await call('evolution.skills.createDraft', { description: 'x' });
    expect(r.ok).toBe(false);
  });
  it('evolution.skills.createDraft 返回新技能', async () => {
    const r = await call('evolution.skills.createDraft', { name: '论文查重', description: 'd', category: 'academic' });
    expect(r.ok).toBe(true);
    expect(r.skill.id).toBe('sk-new');
  });
  it('evolution.ontology.bindings 返回 refs', async () => {
    const r = await call('evolution.ontology.bindings', { skillId: 'sk1' });
    expect(r.ok).toBe(true);
    expect(r.refs).toEqual(['onto-a']);
  });
  it('evolution.ontology.bind 缺 ontologyId 时 ok:false', async () => {
    const r = await call('evolution.ontology.bind', { skillId: 'sk1' });
    expect(r.ok).toBe(false);
  });
  it('evolution.ontology.bind 转发并返回 refs', async () => {
    const r = await call('evolution.ontology.bind', { skillId: 'sk1', ontologyId: 'onto-b' });
    expect(r.ok).toBe(true);
    expect(r.refs).toContain('onto-b');
  });
});

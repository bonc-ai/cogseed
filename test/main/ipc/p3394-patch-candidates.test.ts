import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  req: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;

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

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uP3394PatchCandidates';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-p3394-patch-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  invokeHandler = null;
  vi.resetModules();
  vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({
    invokeHandlers: {},
  }));

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function call(channel: string, payload: unknown = {}): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

async function seedPatchCandidate(conversationId: string, suffix: string) {
  const statePath = path.join(tmpDir, TEST_UID, 'local', 'p3394', 'kstar-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const existing = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, runs: [], experience_candidates: [], patch_candidates: [], updated_at: '2026-07-24T00:00:00.000Z' };
  const run = {
    id: `run-${suffix}`,
    conversation_id: conversationId,
    agent_id: 'writer-agent',
    turn_id: `turn-${suffix}`,
    status: 'completed',
    actual_result: `draft result ${suffix}`,
    evidence_items: [],
    verification: null,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  };
  const candidate = {
    id: `patch-${suffix}`,
    source_run_id: run.id,
    conversation_id: conversationId,
    agent_id: 'writer-agent',
    type: 'skill_patch',
    target: { kind: 'custom_skill', id: 'writer-agent' },
    proposal: {
      title: 'KSTAR propose_skill_patch',
      summary: `Improve workflow ${suffix}.`,
      rationale: `Workflow should improve ${suffix}.`,
      proposed_content: `Improve workflow ${suffix}.`,
    },
    engine: { attribution_id: `attr-${suffix}`, route_action: 'propose_skill_patch' },
    status: 'needs_review',
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  };
  existing.runs.push(run);
  existing.patch_candidates.push(candidate);
  fs.writeFileSync(statePath, JSON.stringify(existing, null, 2));
  return { run, candidate };
}

describe('ipc › p3394 PatchCandidate routes', () => {
  it('lists and reviews patch candidates within the requested conversation scope', async () => {
    const empty = await call('p3394.listPatchCandidates', { cid: 'gconv-patch-a' });
    expect(empty).toMatchObject({ ok: true, patch_candidates: [] });

    const first = await seedPatchCandidate('gconv-patch-a', 'a');
    const second = await seedPatchCandidate('gconv-patch-b', 'b');

    const listed = await call('p3394.listPatchCandidates', { cid: 'gconv-patch-a' });
    expect(listed.ok).toBe(true);
    expect(listed.patch_candidates).toHaveLength(1);
    expect(listed.patch_candidates).toEqual([
      expect.objectContaining({
        id: first.candidate.id,
        conversation_id: 'gconv-patch-a',
        source_run_id: first.run.id,
        status: 'needs_review',
        engine: expect.objectContaining({ attribution_id: 'attr-a', route_action: 'propose_skill_patch' }),
      }),
    ]);
    expect(listed.patch_candidates).not.toEqual([
      expect.objectContaining({ id: second.candidate.id }),
    ]);

    const reviewed = await call('p3394.reviewPatchCandidate', {
      cid: 'gconv-patch-a',
      candidateId: first.candidate.id,
      decision: 'approve',
      notes: 'looks good',
    });
    expect(reviewed.ok).toBe(true);
    expect(reviewed.patch_candidate).toMatchObject({
      id: first.candidate.id,
      status: 'approved',
      review: { decision: 'approve', notes: 'looks good' },
    });

    const refreshed = await call('p3394.listPatchCandidates', { cid: 'gconv-patch-a' });
    expect(refreshed.patch_candidates[0]).toMatchObject({
      id: first.candidate.id,
      status: 'approved',
      review: { decision: 'approve', notes: 'looks good' },
    });

    const wrongScope = await call('p3394.reviewPatchCandidate', {
      cid: 'gconv-patch-a',
      candidateId: second.candidate.id,
      decision: 'reject',
      notes: 'wrong session',
    });
    expect(wrongScope.ok).toBe(false);
    expect(String(wrongScope.error)).toMatch(/not found|scope/i);
  });
});

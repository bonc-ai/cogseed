// 提交幂等（PRD EC-07 / FR-016）：一个 submit_request_id 对应一个耐久 run。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-submit-idem';
const CID = 'cid-idem-1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-idem-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const f = await import('../../../../src/main/features/group_chat/index');
    f._setSubmitPersistenceHooksForTest?.(null);
    await f.dropConv(TEST_UID, CID);
  } catch { /* best effort test cleanup */ }
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function facade() {
  return import('../../../../src/main/features/group_chat/index');
}

async function send(requestId: string, text = '只提交一次') {
  const f = await facade();
  return f.send({ userId: TEST_UID, cid: CID, text, submit_request_id: requestId });
}

async function persistedUserMessages(requestId: string) {
  const { readJsonl } = await import('../../../../src/main/storage');
  const { conversationLayout } = await import('../../../../src/main/util/project-layout');
  const rows = await readJsonl<any>(conversationLayout(TEST_UID, CID).messageFile, 1000);
  return rows.filter((row) => row.from === 'user' && row.action_request_id === requestId);
}

describe('group_chat › durable submit claim（EC-07 幂等）', () => {
  it('同一 ID 并发提交只建立一个 run 和一条用户消息，两次都返回同一接受结果', async () => {
    const requestId = 'req_concurrent1';
    const [a, b] = await Promise.all([send(requestId), send(requestId)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a).toMatchObject({ accepted: true, cid: CID, submit_request_id: requestId });
    expect(b).toMatchObject({ accepted: true, cid: CID, submit_request_id: requestId });
    expect(a.msg?.id).toBeTruthy();
    expect(b.msg?.id).toBe(a.msg?.id);

    const store = await import('../../../../src/main/features/group_chat/run_store');
    expect(await store.listRunIds(TEST_UID, CID)).toHaveLength(1);
    expect(await persistedUserMessages(requestId)).toHaveLength(1);
    expect((await (await facade())._readSubmitClaim(TEST_UID, CID, requestId))?.state)
      .toBe('accepted');
  });

  it('claim 首次持久化失败时 fail closed，不建立 run、不写消息、不派发', async () => {
    const f = await facade();
    let failed = false;
    f._setSubmitPersistenceHooksForTest({
      beforeClaimWrite() {
        if (!failed) {
          failed = true;
          throw new Error('forced claim write failure');
        }
      },
    });
    const result = await send('req_claimfail1');
    expect(result).toMatchObject({ ok: false });
    const store = await import('../../../../src/main/features/group_chat/run_store');
    expect(await store.listRunIds(TEST_UID, CID)).toEqual([]);
    expect(await persistedUserMessages('req_claimfail1')).toEqual([]);
  });

  it('run 持久化失败时保留 preparing claim，但不写消息或派发', async () => {
    const f = await facade();
    f._setSubmitPersistenceHooksForTest({
      beforeRunWrite() { throw new Error('forced run write failure'); },
    });
    const result = await send('req_runfail1');
    expect(result).toMatchObject({ ok: false });
    expect((await f._readSubmitClaim(TEST_UID, CID, 'req_runfail1'))?.state)
      .toBe('preparing');
    const store = await import('../../../../src/main/features/group_chat/run_store');
    expect(await store.listRunIds(TEST_UID, CID)).toEqual([]);
    expect(await persistedUserMessages('req_runfail1')).toEqual([]);
  });

  it('消息 append 后崩溃可用同一耐久身份恢复，不重复消息、run 或队列身份', async () => {
    const f = await facade();
    let crashed = false;
    f._setSubmitPersistenceHooksForTest({
      afterMessageAppend() {
        if (!crashed) {
          crashed = true;
          throw Object.assign(new Error('simulated crash after append'), {
            code: 'TEST_CRASH_AFTER_MESSAGE_APPEND',
          });
        }
      },
    });
    const first = await send('req_crashappend1');
    expect(first.ok).toBe(false);
    expect(await persistedUserMessages('req_crashappend1')).toHaveLength(1);

    f._setSubmitPersistenceHooksForTest(null);
    const replay = await send('req_crashappend1');
    expect(replay.ok).toBe(true);
    expect(await persistedUserMessages('req_crashappend1')).toHaveLength(1);
    const store = await import('../../../../src/main/features/group_chat/run_store');
    expect(await store.listRunIds(TEST_UID, CID)).toHaveLength(1);
    const claim = await f._readSubmitClaim(TEST_UID, CID, 'req_crashappend1');
    expect(claim).toMatchObject({ state: 'accepted', message_id: replay.msg?.id });
    expect(Object.values(claim?.dispatch_turn_ids || {}).every((id) => typeof id === 'string'))
      .toBe(true);
  });

  it('accepted claim 永不过期；十分钟后重放仍返回原消息且不新建 run', async () => {
    const requestId = 'req_oldaccepted1';
    const first = await send(requestId);
    expect(first.ok).toBe(true);
    const f = await facade();
    const claim = await f._readSubmitClaim(TEST_UID, CID, requestId);
    expect(claim).toBeTruthy();
    await f._writeSubmitClaim(TEST_UID, CID, requestId, {
      ...claim!,
      updated_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    });

    const replay = await send(requestId);
    expect(first).toMatchObject({ accepted: true, cid: CID, submit_request_id: requestId });
    expect(replay).toMatchObject({ accepted: true, cid: CID, submit_request_id: requestId });
    expect(replay.msg?.id).toBe(first.msg?.id);
    expect(await persistedUserMessages(requestId)).toHaveLength(1);
    const store = await import('../../../../src/main/features/group_chat/run_store');
    expect(await store.listRunIds(TEST_UID, CID)).toHaveLength(1);
  });

  it('同一 request id 携带不同 payload 会被拒绝，不能复用旧接受结果', async () => {
    const requestId = 'req_payloadconflict1';
    expect((await send(requestId, 'first payload')).ok).toBe(true);
    const conflict = await send(requestId, 'different payload');
    expect(conflict).toMatchObject({ ok: false, error: 'submit request ID payload conflict' });
    expect(await persistedUserMessages(requestId)).toHaveLength(1);
  });
});

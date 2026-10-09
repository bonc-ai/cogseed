import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Same setup shape as turn_buffer.test.ts — WS_ROOT swap + activateUser
// must run before any expert_signals import (storage caches active uid).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-turn-hooks-'));
process.env.COGSEED_WORKSPACE_ROOT = TMP;
fs.writeFileSync(path.join(TMP, 'users.json'),
  JSON.stringify({ current_user_id: '99999993', users: [{ user_id: '99999993', created_at: new Date().toISOString() }] }));
const UID = '99999993';

import { activateUser } from '../../../../src/main/features/users';
activateUser(UID);

import {
  onAgentTurnEnd,
  onUserMessage,
  _clearAgentMsgCache,
} from '../../../../src/main/features/expert_signals/turn_hooks';
import { querySignals } from '../../../../src/main/features/expert_signals';

/**
 * 信号写入是异步 `appendJsonl`：固定 30ms 在满载并发下会读到 0 条
 *（全量套件里 tool_failure 用例就这样失败过）。改成有界条件等待真实条数。
 */
async function waitUntil(
  probe: () => Promise<Array<{ turn_id?: string }>>,
  ok: (sigs: Array<{ turn_id?: string }>) => boolean,
  timeoutMs = 5_000,
): Promise<Array<{ turn_id?: string }>> {
  const deadline = Date.now() + timeoutMs;
  let sigs = await probe();
  while (!ok(sigs) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    sigs = await probe();
  }
  return sigs;
}

/**
 * 负例的非空洞写法：在同一个 cid 上再制造一条「必然产出」的对照信号，
 * 等它落地后断言只有它一条——否则「读到 0 条」可能只是还没落盘。
 */
async function expectOnlyControlToolFailure(cid: string, controlTurnId: string): Promise<void> {
  onAgentTurnEnd({
    uid: UID, cid,
    actorId: 'control_agent',
    isCommander: false,
    agentMsg: { id: controlTurnId, text: 'control turn' },
    errText: 'permanent: control failure',
  });
  const sigs = await waitUntil(
    () => querySignals({ types: ['tool_failure'], cid }),
    (rows) => rows.length === 1,
  );
  expect(sigs).toHaveLength(1);
  expect(sigs[0].turn_id).toBe(controlTurnId);
}

async function expectOnlyControlCorrection(cid: string, controlTurnId: string): Promise<void> {
  onAgentTurnEnd({
    uid: UID, cid,
    actorId: 'control_agent',
    isCommander: false,
    agentMsg: { id: controlTurnId, text: 'control turn' },
  });
  await onUserMessage({ uid: UID, cid, userMsg: { id: `u_${controlTurnId}`, text: '好的，就这样' } });
  const sigs = await waitUntil(
    () => querySignals({ types: ['correction', 'accept', 'reject', 'edit'], cid }),
    (rows) => rows.length === 1,
  );
  expect(sigs).toHaveLength(1);
  expect(sigs[0].turn_id).toBe(controlTurnId);
}

// Why this file exists: phase-0 commit 76358a8e shipped the chokepoint
// functions (onAgentTurnEnd / onUserMessage) and the bus.ts wiring, but
// the bus.ts portion silently fell out of the commit. The fall-out wasn't
// detected because all expert_signals coverage was on the pure extractors
// (text.test.ts / silence.test.ts / event.test.ts) — none exercised the
// chokepoint end-to-end. These fixtures lock the chokepoint behaviour so
// the next time someone refactors turn_hooks or moves the bus call site,
// a missing wire surfaces in the test suite, not in production weeks
// later. See `docs/plans/expert-signals-phase0-wiring-gaps.md`.

beforeEach(() => {
  _clearAgentMsgCache();
});

describe('onAgentTurnEnd › set A (live emit + cache)', () => {
  it('caches agent msg + does NOT emit signals on a clean turn (no errText)', async () => {
    const cid = 'cid-tha-a1';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_a1', text: 'Here is the plan.' },
      // No errText → no tool_failure.
    });
    await expectOnlyControlToolFailure(cid, 'm_ctrl_tha_a1');
    // Cache write is observable via the next onUserMessage call below.
  });

  it('errText non-empty → emits tool_failure once', async () => {
    const cid = 'cid-tha-a2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_a2', text: 'sorry' },
      errText: 'permanent: agent spec missing',
    });
    const sigs = await waitUntil(
      () => querySignals({ types: ['tool_failure'], cid }),
      (rows) => rows.length === 1,
    );
    expect(sigs.length).toBe(1);
    expect(sigs[0].turn_id).toBe('m_a2');
    expect(sigs[0].metadata!.error_excerpt).toContain('agent spec missing');
  });

  it('commander turn → aid is null on emitted signals', async () => {
    const cid = 'cid-tha-a3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'commander',
      isCommander: true,
      agentMsg: { id: 'm_a3', text: 'done.' },
      errText: 'something broke',
    });
    const sigs = await waitUntil(
      () => querySignals({ types: ['tool_failure'], cid }),
      (rows) => rows.length === 1,
    );
    expect(sigs.length).toBe(1);
    expect(sigs[0].aid).toBeNull();
  });
});

describe('onUserMessage › set A (text-signal extraction after cache)', () => {
  it('correction word → emits correction signal joined on cached turn_id', async () => {
    const cid = 'cid-thu-a1';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a1', text: '我帮你写了一段示例代码。' },
    });
    const r = await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a1', text: '不对，应该用另一种写法' },
    });
    expect(r.correctionDetected).toBe(true);
    const sigs = await waitUntil(
      () => querySignals({ types: ['correction'], cid }),
      (rows) => rows.length >= 1,
    );
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0].turn_id).toBe('m_thu_a1');
    expect(sigs[0].aid).toBe('agent_x');
  });

  it('explicit accept word → emits accept signal', async () => {
    const cid = 'cid-thu-a2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a2', text: 'How about this approach?' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a2', text: '好的，就这样' },
    });
    const sigs = await waitUntil(
      () => querySignals({ types: ['accept'], cid }),
      (rows) => rows.length === 1,
    );
    expect(sigs.length).toBe(1);
    expect(sigs[0].turn_id).toBe('m_thu_a2');
  });

  it('rejection word → emits reject signal', async () => {
    const cid = 'cid-thu-a3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_a3', text: '我用 Python 实现一个排序。' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_a3', text: '算了，不要这个了' },
    });
    const sigs = await waitUntil(
      () => querySignals({ types: ['reject'], cid }),
      (rows) => rows.length === 1,
    );
    expect(sigs.length).toBe(1);
  });
});

describe('onUserMessage / onAgentTurnEnd › set B (must NOT emit)', () => {
  it('onUserMessage with no prior onAgentTurnEnd → no signals (cache miss)', async () => {
    const cid = 'cid-thu-b1';
    const r = await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b1', text: '不对' },
    });
    expect(r.correctionDetected).toBe(false);
    await expectOnlyControlCorrection(cid, 'm_ctrl_thu_b1');
  });

  it('silent agent turn (empty text) → no cache, so next user msg gets no signal', async () => {
    const cid = 'cid-thu-b2';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_b2', text: '' },  // silent turn
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b2', text: '不对' },
    });
    await expectOnlyControlCorrection(cid, 'm_ctrl_thu_b2');
  });

  it('neutral user reply → no correction/accept/reject (might still emit edit if it looks like one)', async () => {
    const cid = 'cid-thu-b3';
    onAgentTurnEnd({
      uid: UID, cid,
      actorId: 'agent_x',
      isCommander: false,
      agentMsg: { id: 'm_thu_b3', text: '我建议先做需求分析。' },
    });
    await onUserMessage({
      uid: UID, cid,
      userMsg: { id: 'u_b3', text: '我去问问产品经理' },
    });
    await expectOnlyControlCorrection(cid, 'm_ctrl_thu_b3');
  });
});
